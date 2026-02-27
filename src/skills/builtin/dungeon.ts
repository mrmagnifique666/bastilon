/**
 * Dungeon Master in a Box — Kingston becomes a TTRPG DM.
 * Supports D&D 5e and Shadowrun rulesets with optional co-op (Kingston as AI player).
 *
 * dungeon.start     — Create a new campaign (D&D or Shadowrun, solo or co-op)
 * dungeon.play      — Main game loop (player action → DM narrative → optional AI turn)
 * dungeon.scene     — Generate a scene image via Pollinations.ai
 * dungeon.roll      — Roll dice (NdX+M or Shadowrun d6 pool)
 * dungeon.status    — Current session state
 * dungeon.inventory — Manage character inventory
 * dungeon.history   — Narrative recap
 * dungeon.sessions  — List/load/delete/pause/resume campaigns
 */
import crypto from "node:crypto";
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";
import {
  dungeonCreateSession, dungeonGetSession, dungeonListSessions,
  dungeonUpdateSession, dungeonDeleteSession,
  dungeonAddCharacter, dungeonGetCharacters, dungeonUpdateCharacter,
  dungeonAddTurn, dungeonGetTurns,
  dungeonSetAdventure, dungeonGetAdventure, dungeonUpdateAdventure,
  kgUpsertEntity, kgAddRelation, kgGetEntity, kgGetRelations, kgTraverse,
  logEpisodicEvent, recallEvents,
  savedCharCreate, savedCharGet, savedCharList, savedCharUpdate, savedCharDelete,
  savedCharSyncFromSession,
} from "../../storage/store.js";

// ── Dice roller (D&D) ──

interface DiceResult {
  type: string;
  rolls: number[];
  modifier: number;
  total: number;
  purpose?: string;
}

function rollDice(notation: string, purpose?: string): DiceResult {
  const match = notation.match(/^(\d*)d(\d+)([+-]\d+)?$/i);
  if (!match) {
    const num = parseInt(notation, 10);
    if (!isNaN(num)) return { type: notation, rolls: [num], modifier: 0, total: num, purpose };
    return { type: notation, rolls: [0], modifier: 0, total: 0, purpose };
  }
  const count = parseInt(match[1] || "1", 10);
  const sides = parseInt(match[2], 10);
  const modifier = parseInt(match[3] || "0", 10);
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) rolls.push(crypto.randomInt(1, sides + 1));
  const total = rolls.reduce((a, b) => a + b, 0) + modifier;
  return { type: notation, rolls, modifier, total, purpose };
}

// ── Shadowrun d6 Pool Roller ──

interface ShadowrunPoolResult {
  pool: number;
  rolls: number[];
  hits: number;
  ones: number;
  isGlitch: boolean;
  isCriticalGlitch: boolean;
  purpose?: string;
}

function rollShadowrunPool(pool: number, purpose?: string): ShadowrunPoolResult {
  const rolls: number[] = [];
  for (let i = 0; i < pool; i++) rolls.push(crypto.randomInt(1, 7));
  const hits = rolls.filter(r => r >= 5).length;
  const ones = rolls.filter(r => r === 1).length;
  const isGlitch = ones > pool / 2;
  const isCriticalGlitch = isGlitch && hits === 0;
  return { pool, rolls, hits, ones, isGlitch, isCriticalGlitch, purpose };
}

// ── Shadowrun Rules & DM Prompt ──

function buildShadowrunRules(): string {
  return `REGLES SHADOWRUN (simplifie):
- Systeme de d6 dice pool: lance [Attribut + Competence] d6
- Succes (hit) = resultat de 5 ou 6 sur chaque de
- Glitch = plus de la moitie des des sont des 1
- Glitch Critique = glitch + 0 succes (catastrophe!)
- Seuils: Facile=1, Moyen=2, Difficile=3, Extreme=4+
- Combat: Initiative = Reaction + Intuition (d6 pool), jets opposes attaque/defense
- Dommages: Piste Physique (Body/2+8) et Piste Etourdissement (Willpower/2+8)
- Matrix: Deckers piratent via cyberdeck, jets Logique+Hacking
- Magie: Mages/Shamans canalisent le mana, drain = degats Etourdissement
- Edge: points de chance, depenser pour relancer des rates ou exploser (6=relance)
- Essence: max 6.0, chaque cyberware retire de l'Essence, affecte la magie
- Monde: Seattle 2080, megacorps (Ares, Aztechnology, Renraku, Saeder-Krupp), ombres, runners`;
}

function buildDMPrompt(session: any, characters: any[], recentTurns: any[]): string {
  const isShad = session.ruleset === "shadowrun";

  const charList = characters
    .filter((c) => !c.is_npc)
    .map((c) => {
      const inv = Array.isArray(c.inventory) ? c.inventory.join(", ") : "rien";
      const tag = c.is_ai ? " [IA Kingston]" : "";
      if (isShad) {
        const s = c.stats || {};
        return `- ${c.name}${tag} (${c.race} ${c.class}) Body:${s.body||3} Agi:${s.agility||3} Rea:${s.reaction||3} Log:${s.logic||3} Cha:${s.charisma||3} Edge:${s.edge||2} Essence:${s.essence||6} PV:${c.hp}/${c.hp_max} Stun:${s.stun_current||0}/${s.stun_max||10} Inventaire:[${inv}]`;
      }
      return `- ${c.name}${tag} (${c.race} ${c.class} Niv.${c.level}) HP:${c.hp}/${c.hp_max} Inventaire:[${inv}]`;
    })
    .join("\n");

  const npcs = characters
    .filter((c) => c.is_npc)
    .map((c) => `- ${c.name} (${c.race} ${c.class}) — ${c.description || "PNJ"}`)
    .join("\n");

  const history = recentTurns
    .map((t) => {
      const actorLabel = t.actor === "ai" ? "[Kingston]" : t.actor === "dm" ? "[DM]" : "[Joueur]";
      let line = `Tour ${t.turn_number}:`;
      if (t.player_action) line += ` ${actorLabel} ${t.player_action}`;
      if (t.dm_narrative) line += `\n[DM] ${t.dm_narrative.slice(0, 200)}`;
      return line;
    })
    .join("\n\n");

  if (isShad) {
    return `Tu es un Game Master expert pour Shadowrun. Tu narres en FRANCAIS.

${buildShadowrunRules()}

STYLE:
- Narration immersive cyberpunk (3-5 paragraphes), neon, pluie, ombres
- Utilise les dice pools Shadowrun: indique [Pool Xd6: Y succes vs seuil Z]
- Les runs sont dangereux — corps, Matrix et astral sont tous mortels
- Fais vivre le monde: gangers, corpos, fixers, esprits, CI noires
- Propose 2-3 options a la fin de chaque tour
- Gere les nuyen (argent), karma, et reputation

CONTEXTE ACTUEL:
Run: ${session.name}
Setting: ${session.setting || "Seattle 2080, Ombres"}
Lieu: ${session.current_location}
Tour: ${session.turn_number}

SHADOWRUNNERS:
${charList || "Aucun runner cree"}

PNJs PRESENTS:
${npcs || "Aucun PNJ"}

DERNIERS EVENEMENTS:
${history || "Debut du run"}`;
  }

  // D&D 5e prompt (original)
  return `Tu es un Dungeon Master expert pour D&D 5e. Tu narres en FRANCAIS.

REGLES:
- Narration immersive et descriptive (3-5 paragraphes)
- Respecte les regles D&D 5e (avantage/desavantage, jets de sauvegarde, CA)
- Lance les des automatiquement quand necessaire (indique [d20=15+3=18 vs CA 14: touche!])
- Les combats sont dangereux mais justes
- Decris les consequences des actions du joueur
- Propose 2-3 options a la fin de chaque tour
- Sois creatif avec les PNJs (voix, personnalite)
- Gere les tresors, XP, et progression de niveau

CONTEXTE ACTUEL:
Campagne: ${session.name}
Setting: ${session.setting || "Heroic Fantasy classique"}
Lieu: ${session.current_location}
Tour: ${session.turn_number}

PERSONNAGES JOUEURS:
${charList || "Aucun personnage cree"}

PNJs PRESENTS:
${npcs || "Aucun PNJ"}

DERNIERS EVENEMENTS:
${history || "Debut de l'aventure"}`;
}

// ── Kingston AI Co-Player Prompt ──

function buildAIPlayerPrompt(aiChar: any, allChars: any[], recentTurns: any[], session: any, personality?: string, memoryContext?: string): string {
  const partners = allChars
    .filter(c => !c.is_npc && c.name !== aiChar.name)
    .map(c => `${c.name} (${c.race} ${c.class})${c.is_ai ? ' [IA]' : ''}`)
    .join(", ");

  const last6 = recentTurns.slice(-6).map(t => {
    const who = t.actor === "ai" ? (t.ai_name || "IA") : t.actor === "dm" ? "DM" : "Joueur";
    return `[${who}] ${(t.player_action || t.dm_narrative || "").slice(0, 120)}`;
  }).join("\n");

  const isShad = session.ruleset === "shadowrun";
  const inv = Array.isArray(aiChar.inventory) ? aiChar.inventory.join(", ") : "rien";

  const personalityMap: Record<string, string> = {
    tactical: "Tu es methodique et calcule. Tu analyses avant d'agir, tu proposes des strategies.",
    reckless: "Tu es temeraire et impulsif. Tu fonces d'abord, tu reflechis apres. Tu aimes le danger.",
    cautious: "Tu es prudent et calcule. Tu evites les risques inutiles, tu recommandes la prudence.",
    charismatic: "Tu es charmeur et social. Tu preferes la diplomatie au combat, tu parles aux PNJ.",
    mysterious: "Tu es enigmatique et silencieux. Peu de mots, beaucoup d'actions decisives.",
    comic: "Tu es drole et leger. Tout est pretexte a une blague ou un commentaire ironique.",
    wise: "Tu es sage et reflechi. Tu donnes des conseils et tu rappelles les lecons du passe.",
    aggressive: "Tu es agressif et direct. Aucune patience pour la diplomatie, tu veux l'action."
  };
  const personalityDesc = personalityMap[personality || ""] || personalityMap.tactical;

  return `Tu es ${aiChar.name}, un personnage IA dans une partie de ${isShad ? "Shadowrun" : "D&D 5e"}.
Tu incarnes **${aiChar.name}** (${aiChar.race} ${aiChar.class}).
${isShad ? `Stats: Body:${aiChar.stats?.body||3} Agi:${aiChar.stats?.agility||3} Log:${aiChar.stats?.logic||6} Edge:${aiChar.stats?.edge||3}` : `Stats: STR:${aiChar.stats?.str||10} DEX:${aiChar.stats?.dex||14} INT:${aiChar.stats?.int||16}`}
Inventaire: ${inv}
PV: ${aiChar.hp}/${aiChar.hp_max}

Tes coequipiers: ${partners || "solo"}

PERSONNALITE:
${personalityDesc}

SOUVENIRS & RELATIONS:
${memoryContext || "Premiere aventure — aucun souvenir."}

REGLES DE COMPORTEMENT:
- Reste IN-CHARACTER — tu es ${aiChar.name}, avec ta propre personnalite
- Sois CONCIS: 1-2 phrases maximum pour decrire ton action
- ${isShad ? "Utilise tes competences specifiques a ton role (Decker=hacking, Street Sam=combat, Mage=sorts, etc.)" : "Utilise tes competences de classe strategiquement"}
- Ne repete jamais l'action d'un coequipier
- Sois COMPLEMENTAIRE: couvre ce que les autres ne font pas
- Si tu as des souvenirs, UTILISE-LES: mentionne tes relations, tes experiences passees

TU AS DEUX OPTIONS:
1. AGIR: Decris ton action en 1-2 phrases (le DM reagira).
2. PARLER AU GROUPE: Prefixe avec [PARTY] pour parler directement aux joueurs sans intervention du DM. Ex: [PARTY] ${partners?.split(",")[0]?.trim() || "Hey"}, je pense qu'on devrait...

DERNIERS EVENEMENTS:
${last6 || "Debut de l'aventure"}

Decide ton action ou parle au groupe. Reponds en 1-2 phrases, en francais.`;
}

// ── AI Memory Helpers ──

/** Extract NPC names from narrative text (capitalized proper nouns, filtering known PCs) */
function extractNPCsFromNarrative(narrative: string, knownChars: string[]): string[] {
  const known = new Set(knownChars.map(n => n.toLowerCase()));
  const matches = narrative.match(/\b[A-Z\u00C0-\u00FF][a-z\u00E0-\u00FF]{2,}/g) || [];
  // Common French/DM words to skip
  const skipWords = new Set(["Tour", "DM", "IA", "Joueur", "Pool", "Succes", "Glitch", "Debut", "Fin",
    "Vous", "Elle", "Ils", "Une", "Des", "Les", "Par", "Dans", "Sur", "Avec", "Pour", "Mais",
    "Run", "Matrix", "Edge", "Body", "Seuil", "Combat", "Action", "Inventaire", "Personnalite"]);
  const seen = new Set<string>();
  return matches.filter(m => {
    const lower = m.toLowerCase();
    if (known.has(lower) || skipWords.has(m) || seen.has(lower)) return false;
    seen.add(lower);
    return true;
  }).slice(0, 5);
}

/** Simple sentiment heuristic: positive/negative keywords → valence */
function detectSentiment(text: string): number {
  const lower = text.toLowerCase();
  const negWords = ["mort", "piege", "blesse", "echec", "glitch", "critique", "poison", "trahison", "embuscade", "douleur", "perte"];
  const posWords = ["victoire", "tresor", "allie", "succes", "reussi", "guerison", "sauve", "or", "recompense", "amitie"];
  let score = 0;
  for (const w of negWords) if (lower.includes(w)) score -= 0.3;
  for (const w of posWords) if (lower.includes(w)) score += 0.3;
  return Math.max(-1, Math.min(1, score));
}

/** Build memory context for an AI character from KG + episodic memory */
async function buildAIMemoryContext(charName: string, sessionId: number, sessionName: string): Promise<string> {
  const parts: string[] = [];

  // Episodic: last memorable events involving this character
  try {
    const events = recallEvents({ search: charName, limit: 6, minImportance: 0.3 });
    if (events.length > 0) {
      const eventLines = events.map(e => {
        const valence = e.emotional_valence > 0.2 ? "(+)" : e.emotional_valence < -0.2 ? "(-)" : "";
        return `- ${e.summary.slice(0, 80)} ${valence}`;
      });
      parts.push(`Souvenirs recents:\n${eventLines.join("\n")}`);
    }
  } catch { /* episodic recall failed — no memory */ }

  // KG: character entity + relations
  try {
    const entity = kgGetEntity(charName, "dungeon_character");
    if (entity) {
      const rels = kgGetRelations(entity.id);
      if (rels.length > 0) {
        const relLines = rels.slice(0, 6).map(r => {
          const other = r.from_name === charName ? r.to_name : r.from_name;
          return `- ${other}: ${r.relation_type}`;
        });
        parts.push(`Relations:\n${relLines.join("\n")}`);
      }
      // 1-hop traverse for locations/items
      const connected = kgTraverse(entity.id, 1);
      const locations = connected.filter(c => c.entity.entity_type === "dungeon_location").slice(0, 3);
      if (locations.length > 0) {
        parts.push(`Lieux visites: ${locations.map(l => l.entity.name).join(", ")}`);
      }
    }
  } catch { /* KG not available */ }

  if (parts.length === 0) return "Premiere aventure — aucun souvenir.";
  // Cap at ~300 chars to stay within Ollama context
  const full = parts.join("\n");
  return full.length > 300 ? full.slice(0, 297) + "..." : full;
}

// ── Shadowrun Character Templates ──

interface ShadowrunRole {
  class: string;
  stats: Record<string, number>;
  gear: string[];
  description: string;
}

const SHADOWRUN_ROLES: Record<string, ShadowrunRole> = {
  "street samurai": {
    class: "Street Samurai",
    stats: { body: 5, agility: 5, reaction: 5, strength: 4, willpower: 3, logic: 3, intuition: 4, charisma: 2, edge: 3, essence: 2.5 },
    gear: ["Ares Predator V", "Katana", "Armure corporelle", "Smartlink", "Reflexes cables Niv.2", "Commlink"],
    description: "Guerrier cybernétique, expert en combat et armement",
  },
  "decker": {
    class: "Decker",
    stats: { body: 3, agility: 3, reaction: 4, strength: 2, willpower: 4, logic: 6, intuition: 5, charisma: 3, edge: 3, essence: 4.5 },
    gear: ["Cyberdeck Hermes Chariot", "Pistolet leger", "Datajack", "AR Contacts", "Kit de hacking", "Commlink encrypte"],
    description: "Pirate de la Matrix, expert en intrusion numerique",
  },
  "mage": {
    class: "Mage",
    stats: { body: 3, agility: 3, reaction: 3, strength: 2, willpower: 5, logic: 5, intuition: 4, charisma: 4, edge: 3, essence: 6.0 },
    gear: ["Focus de sorts Niv.2", "Masque a gaz", "Materiaux rituels", "Manteau blinde", "Commlink"],
    description: "Lanceur de sorts hermétique, puissant mais fragile",
  },
  "shaman": {
    class: "Shaman",
    stats: { body: 3, agility: 3, reaction: 3, strength: 2, willpower: 5, logic: 3, intuition: 5, charisma: 5, edge: 3, essence: 6.0 },
    gear: ["Totem spirituel", "Focus d'invocation Niv.2", "Couteau rituel", "Lodge portable", "Commlink"],
    description: "Invocateur d'esprits, guide par son Totem",
  },
  "rigger": {
    class: "Rigger",
    stats: { body: 3, agility: 4, reaction: 5, strength: 2, willpower: 3, logic: 5, intuition: 4, charisma: 2, edge: 3, essence: 3.0 },
    gear: ["Console de controle", "Drone MCT Fly-Spy x2", "Drone Steel Lynx (combat)", "Interface de commande", "Van blindee", "Commlink"],
    description: "Pilote de drones et vehicules, yeux et oreilles de l'equipe",
  },
  "face": {
    class: "Face",
    stats: { body: 3, agility: 3, reaction: 3, strength: 2, willpower: 4, logic: 4, intuition: 4, charisma: 6, edge: 4, essence: 4.0 },
    gear: ["Tailored Pheromones Niv.2", "Armure haute couture", "Faux SIN Premium", "Pistolet cache", "Commlink de luxe"],
    description: "Negociateur et manipulateur, visage de l'equipe",
  },
  "adept": {
    class: "Adept",
    stats: { body: 4, agility: 5, reaction: 5, strength: 4, willpower: 4, logic: 2, intuition: 4, charisma: 3, edge: 3, essence: 6.0 },
    gear: ["Arme de corps a corps", "Vetements blindes", "Gants renforces", "Commlink"],
    description: "Artiste martial magique, ki et prouesses physiques",
  },
  "technomancer": {
    class: "Technomancer",
    stats: { body: 3, agility: 3, reaction: 4, strength: 2, willpower: 5, logic: 5, intuition: 5, charisma: 3, edge: 3, essence: 6.0 },
    gear: ["Sprites compiles x2", "Datajack organique", "Vetements discrets", "Commlink vivant"],
    description: "Hacker naturel de la Matrix, pas besoin de cyberdeck",
  },
};

const SHADOWRUN_METATYPES: Record<string, { body: number; agility: number; strength: number; charisma: number }> = {
  humain:  { body: 0, agility: 0, strength: 0, charisma: 0 },
  elf:     { body: 0, agility: 1, strength: 0, charisma: 2 },
  nain:    { body: 2, agility: 0, strength: 2, charisma: 0 },
  ork:     { body: 3, agility: 0, strength: 2, charisma: -1 },
  troll:   { body: 4, agility: -1, strength: 4, charisma: -2 },
};

function createShadowrunCharacter(name: string, metatype: string, roleName: string, isAi = false): {
  name: string; race: string; class: string; hp: number; hp_max: number;
  stats: Record<string, number>; inventory: string[]; is_ai: boolean;
} {
  const role = SHADOWRUN_ROLES[roleName.toLowerCase()] || SHADOWRUN_ROLES["street samurai"];
  const metaMods = SHADOWRUN_METATYPES[metatype.toLowerCase()] || SHADOWRUN_METATYPES["humain"];

  const stats = { ...role.stats };
  stats.body = Math.max(1, (stats.body || 3) + (metaMods.body || 0));
  stats.agility = Math.max(1, (stats.agility || 3) + (metaMods.agility || 0));
  stats.strength = Math.max(1, (stats.strength || 3) + (metaMods.strength || 0));
  stats.charisma = Math.max(1, (stats.charisma || 3) + (metaMods.charisma || 0));

  // Physical track = ceil(Body/2) + 8, Stun track = ceil(Willpower/2) + 8
  const physicalTrack = Math.ceil(stats.body / 2) + 8;
  const stunTrack = Math.ceil((stats.willpower || 3) / 2) + 8;
  stats.stun_current = 0;
  stats.stun_max = stunTrack;

  return {
    name, race: metatype.charAt(0).toUpperCase() + metatype.slice(1).toLowerCase(),
    class: role.class,
    hp: physicalTrack, hp_max: physicalTrack,
    stats,
    inventory: [...role.gear],
    is_ai: isAi,
  };
}

// ── Phase State (3-phase TTRPG system) ──

interface PhaseState {
  sessionId: number;
  phase: "narration" | "strategy" | "action" | "idle";
  lastNarration: string;
  strategyMessages: { role: string; content: string }[];
}
const activePhases = new Map<number, PhaseState>(); // key = Telegram chatId

// ── Call DM via Ollama ──

async function callDM(systemPrompt: string, userMessage: string, chatId = 400): Promise<string> {
  try {
    const { runOllamaChat } = await import("../../llm/ollamaClient.js");
    return await runOllamaChat({ chatId, userMessage: `${systemPrompt}\n\n${userMessage}`, isAdmin: true, userId: 0 });
  } catch (err) {
    log.warn(`[dungeon] Ollama failed (chatId ${chatId}): ${err}`);
    return "";
  }
}

// ── Detect event type ──

function detectEventType(action: string, narrative: string): string {
  const la = action.toLowerCase();
  const ln = narrative.toLowerCase();
  if (la.includes("attaque") || la.includes("combat") || la.includes("tire") || ln.includes("combat") || ln.includes("initiative")) return "combat";
  if (la.includes("parle") || la.includes("discute") || la.includes("dialogue") || la.includes("negocie")) return "dialogue";
  if (la.includes("hacke") || la.includes("matrix") || la.includes("pirate") || la.includes("decrypt")) return "matrix";
  if (la.includes("enigme") || la.includes("puzzle")) return "puzzle";
  if (la.includes("repos") || la.includes("dormir") || la.includes("planque")) return "rest";
  if (la.includes("achete") || la.includes("vend") || la.includes("marchand") || la.includes("nuyen")) return "shop";
  return "exploration";
}

// ── Skills ──

registerSkill({
  name: "dungeon.start",
  description: "Create a new TTRPG campaign (D&D 5e or Shadowrun, solo or co-op with Kingston)",
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Campaign name" },
      setting: { type: "string", description: "Campaign setting/theme" },
      characters: { type: "string", description: "Characters as 'Name/Race/Class, ...' e.g. 'Thorin/Nain/Guerrier'" },
      ruleset: { type: "string", description: "'dnd5e' (default) or 'shadowrun'" },
      coop: { type: "boolean", description: "True = AI players alongside (legacy single mode)" },
      kingston_char: { type: "string", description: "Legacy: Kingston's character as 'Name/Metatype/Role'" },
      ai_players: { type: "string", description: "JSON array of AI players: [{name, personality, voice}]" },
      shadowrun_options: { type: "string", description: "JSON: {runType, district, megacorp}" },
    },
    required: ["name"],
  },
  async execute(args) {
    const name = String(args.name);
    const ruleset = String(args.ruleset || "dnd5e").toLowerCase();
    const isShadowrun = ruleset === "shadowrun";
    const coop = Boolean(args.coop);

    // Parse AI players (new multi-AI system)
    let aiPlayerDefs: Array<{ name: string; personality: string; voice: string }> = [];
    if (args.ai_players) {
      try { aiPlayerDefs = JSON.parse(String(args.ai_players)); } catch { /* ignore parse errors */ }
    }
    // Legacy fallback: single co-op
    if (coop && aiPlayerDefs.length === 0 && args.kingston_char) {
      aiPlayerDefs = [{ name: "Kingston", personality: "tactical", voice: "fr-male" }];
    }

    // Parse Shadowrun options
    let srOpts: { runType?: string; district?: string; megacorp?: string } = {};
    if (args.shadowrun_options) {
      try { srOpts = JSON.parse(String(args.shadowrun_options)); } catch { /* ignore */ }
    }

    const district = srOpts.district && srOpts.district !== "random" ? srOpts.district : "Redmond Barrens";
    const setting = args.setting ? String(args.setting) :
      isShadowrun ? `Seattle 2080, ${srOpts.runType || "Extraction"} run, ${srOpts.megacorp && srOpts.megacorp !== "random" ? srOpts.megacorp : "megacorp"}` :
      "Heroic Fantasy classique";
    const startLocation = isShadowrun ? `Bar du Coyote Rouille, ${district}` : "Taverne du Dragon Endormi";

    // Create session with ruleset
    const sessionId = dungeonCreateSession(name, setting, ruleset);
    dungeonUpdateSession(sessionId, { current_location: startLocation });

    const created: string[] = [];

    if (isShadowrun) {
      // Parse Shadowrun characters: Name/Metatype/Role
      const charStr = String(args.characters || "Runner/Humain/Street Samurai");
      const charDefs = charStr.split(",").map(c => c.trim());

      for (const def of charDefs) {
        const parts = def.split("/").map(p => p.trim());
        const charData = createShadowrunCharacter(
          parts[0] || "Runner",
          parts[1] || "Humain",
          parts[2] || "Street Samurai"
        );
        const charId = dungeonAddCharacter(sessionId, charData);
        created.push(`${charData.name} (${charData.race} ${charData.class}, PV:${charData.hp}, ID:${charId})`);
      }

      // Multi-AI: create AI characters
      if (aiPlayerDefs.length > 0) {
        const srRoles = ["Street Samurai", "Decker", "Mage", "Shaman", "Rigger", "Face", "Adept", "Technomancer"];
        const srMetatypes = ["Humain", "Elf", "Nain", "Ork", "Troll"];
        for (let aiIdx = 0; aiIdx < aiPlayerDefs.length; aiIdx++) {
          const aiDef = aiPlayerDefs[aiIdx];
          const aiName = aiDef.name || `IA-${aiIdx + 1}`;
          // Pick a role that complements existing chars
          const usedRoles = created.map(c => c.match(/\(.*?(\w+),/)?.[1] || "");
          const availRoles = srRoles.filter(r => !usedRoles.some(u => u.toLowerCase() === r.toLowerCase()));
          const role = availRoles[aiIdx % availRoles.length] || srRoles[aiIdx % srRoles.length];
          const metatype = srMetatypes[(aiIdx + 1) % srMetatypes.length]; // vary metatypes
          const kChar = createShadowrunCharacter(aiName, metatype, role, true);
          (kChar as any).personality = aiDef.personality || "tactical";
          (kChar as any).voice = aiDef.voice || "fr-male";
          const kId = dungeonAddCharacter(sessionId, kChar);
          created.push(`${kChar.name} (${kChar.race} ${kChar.class}, PV:${kChar.hp}, ID:${kId}) [IA:${aiDef.personality || "tactical"}]`);
        }
      } else if (coop) {
        // Legacy single co-op fallback
        const kParts = String(args.kingston_char || "Kingston/Elf/Decker").split("/").map(p => p.trim());
        const kChar = createShadowrunCharacter(kParts[0] || "Kingston", kParts[1] || "Elf", kParts[2] || "Decker", true);
        const kId = dungeonAddCharacter(sessionId, kChar);
        created.push(`${kChar.name} (${kChar.race} ${kChar.class}, PV:${kChar.hp}, ID:${kId}) [IA]`);
      }
    } else {
      // D&D 5e character creation (original)
      const charStr = String(args.characters || "Aventurier/Humain/Guerrier");
      const charDefs = charStr.split(",").map(c => c.trim());

      for (const def of charDefs) {
        const parts = def.split("/").map(p => p.trim());
        const charName = parts[0] || "Aventurier";
        const race = parts[1] || "Humain";
        const charClass = parts[2] || "Guerrier";

        const hpMap: Record<string, number> = {
          guerrier: 12, paladin: 12, barbare: 14,
          magicien: 8, sorcier: 8, mage: 8,
          voleur: 10, roublard: 10, ranger: 12, rodeur: 12,
          clerc: 10, pretre: 10, druide: 10,
          barde: 10, moine: 10, artificier: 10,
        };
        const hp = hpMap[charClass.toLowerCase()] || 10;

        const stats: Record<string, number> = {};
        for (const stat of ["str", "dex", "con", "int", "wis", "cha"]) {
          const rolls = Array.from({ length: 4 }, () => crypto.randomInt(1, 7));
          rolls.sort((a, b) => b - a);
          stats[stat] = rolls[0] + rolls[1] + rolls[2];
        }

        const charId = dungeonAddCharacter(sessionId, {
          name: charName, race, class: charClass,
          hp, hp_max: hp, stats,
          inventory: ["Sac a dos", "Rations (5j)", "Torche x3", "50 pieces d'or"],
        });
        created.push(`${charName} (${race} ${charClass}, HP:${hp}, ID:${charId})`);
      }

      // Multi-AI for D&D
      if (aiPlayerDefs.length > 0) {
        const dndClasses = ["Guerrier", "Mage", "Voleur", "Clerc", "Ranger", "Barde", "Paladin", "Druide"];
        const dndRaces = ["Humain", "Elfe", "Nain", "Halfelin", "Gnome", "Demi-Orque", "Tieffelin", "Drakeid"];
        for (let aiIdx = 0; aiIdx < aiPlayerDefs.length; aiIdx++) {
          const aiDef = aiPlayerDefs[aiIdx];
          const aiName = aiDef.name || `IA-${aiIdx + 1}`;
          const usedClasses = created.map(c => c.match(/\(.*?(\w+),/)?.[1] || "");
          const availClasses = dndClasses.filter(cl => !usedClasses.some(u => u.toLowerCase() === cl.toLowerCase()));
          const charClass = availClasses[aiIdx % availClasses.length] || dndClasses[aiIdx % dndClasses.length];
          const race = dndRaces[(aiIdx + 1) % dndRaces.length];
          const stats: Record<string, number> = {};
          for (const stat of ["str", "dex", "con", "int", "wis", "cha"]) {
            const rolls = Array.from({ length: 4 }, () => crypto.randomInt(1, 7));
            rolls.sort((a, b) => b - a);
            stats[stat] = rolls[0] + rolls[1] + rolls[2];
          }
          const hpMap: Record<string, number> = { guerrier:12, paladin:12, barbare:14, mage:8, voleur:10, clerc:10, druide:10, barde:10, ranger:12 };
          const hp = hpMap[charClass.toLowerCase()] || 10;
          const kId = dungeonAddCharacter(sessionId, {
            name: aiName, race, class: charClass, hp, hp_max: hp, stats,
            inventory: ["Sac a dos", "Rations (5j)", "Torche x3", "50 pieces d'or"],
            is_ai: true,
          });
          created.push(`${aiName} (${race} ${charClass}, HP:${hp}, ID:${kId}) [IA:${aiDef.personality || "tactical"}]`);
        }
      } else if (coop) {
        // Legacy single co-op
        const kParts = String(args.kingston_char || "Kingston/Elfe/Mage").split("/").map(p => p.trim());
        const stats: Record<string, number> = {};
        for (const stat of ["str", "dex", "con", "int", "wis", "cha"]) {
          const rolls = Array.from({ length: 4 }, () => crypto.randomInt(1, 7));
          rolls.sort((a, b) => b - a);
          stats[stat] = rolls[0] + rolls[1] + rolls[2];
        }
        const kId = dungeonAddCharacter(sessionId, {
          name: kParts[0] || "Kingston", race: kParts[1] || "Elfe",
          class: kParts[2] || "Mage", hp: 8, hp_max: 8, stats,
          inventory: ["Baton arcanique", "Grimoire", "Composantes magiques", "Robe enchantee"],
          is_ai: true,
        });
        created.push(`${kParts[0] || "Kingston"} (${kParts[1] || "Elfe"} ${kParts[2] || "Mage"}, HP:8, ID:${kId}) [IA]`);
      }
    }

    // Knowledge Graph
    const campaignEntityId = kgUpsertEntity(name, "dungeon_campaign", { setting, sessionId, ruleset });
    kgUpsertEntity(startLocation, "dungeon_location", { sessionId, description: "Point de depart" });
    const locId = kgUpsertEntity(startLocation, "dungeon_location");
    kgAddRelation(campaignEntityId, locId, "starts_at");

    // Episodic event
    logEpisodicEvent("campaign_start", `Nouvelle campagne ${isShadowrun ? "Shadowrun" : "D&D"}: "${name}" (${setting})${coop ? " [CO-OP]" : ""}`, {
      importance: 0.8,
      details: `Personnages: ${created.join(", ")}`,
      source: "dungeon",
    });

    // Intro narrative
    const aiCount = aiPlayerDefs.length;
    const coopNote = aiCount > 0 ? `\n**Mode Co-op actif** — ${aiCount} joueur(s) IA rejoignent l'aventure!\n` :
      coop ? "\n**Mode Co-op actif** — Kingston joue avec vous!\n" : "";
    if (isShadowrun) {
      const intro = `**${name}** — *${setting}*\n\n` +
        `Le run commence. La pluie acide tambourine sur la tole du **${startLocation}**. ` +
        `L'enseigne au neon grésille, projetant des ombres rouges sur le trottoir craquelé. ` +
        `Un fixer vous attend dans l'arriere-salle, un dossier holographique flottant au-dessus de la table.\n\n` +
        `**Runners crees:**\n${created.map(c => `- ${c}`).join("\n")}\n${coopNote}\n` +
        `Session ID: ${sessionId} | Ruleset: Shadowrun\n` +
        `*Utilisez \`dungeon.play\` pour commencer le run!*`;
      return intro;
    }

    const intro = `**${name}** — *${setting}*\n\n` +
      `La campagne commence! Vos aventuriers se retrouvent dans la **${startLocation}**, ` +
      `un lieu chaleureux ou les flammes de la cheminee dansent sur les murs de pierre. ` +
      `L'aubergiste, un vieux nain nomme Grimbald, essuie un verre en vous observant d'un oeil curieux.\n\n` +
      `**Personnages crees:**\n${created.map(c => `- ${c}`).join("\n")}\n${coopNote}\n` +
      `Session ID: ${sessionId}\n` +
      `*Utilisez \`dungeon.play\` pour commencer l'aventure!*`;

    return intro;
  },
});

registerSkill({
  name: "dungeon.prep",
  description: "Prepare a full TTRPG adventure blueprint before playing — generates story beats, map, NPCs, factions",
  argsSchema: {
    type: "object",
    properties: {
      session_id: { type: "number", description: "Session ID to attach the adventure to" },
      tone: { type: "string", description: "'dark', 'heroic', or 'humorous' (default: dark)" },
      run_type: { type: "string", description: "'extraction', 'sabotage', 'escort', 'heist' (default: extraction)" },
    },
    required: ["session_id"],
  },
  async execute(args) {
    const sessionId = Number(args.session_id);
    const session = dungeonGetSession(sessionId);
    if (!session) return "Session introuvable. Creez une session avec dungeon.start d'abord.";

    const tone = String(args.tone || "dark");
    const runType = String(args.run_type || "extraction");
    const isShad = session.ruleset === "shadowrun";
    const characters = dungeonGetCharacters(sessionId);
    const pcNames = characters.filter((c: any) => !c.is_npc).map((c: any) => `${c.name} (${c.race} ${c.class})`).join(", ");

    const prepPrompt = `Tu es un Game Master expert pour ${isShad ? "Shadowrun" : "D&D 5e"}.
Genere un blueprint d'aventure complet au format JSON UNIQUEMENT (pas de texte autour).
Le JSON doit avoir cette structure exacte:
{
  "campaign_name": "nom evocateur de la run/aventure",
  "hook": "la mission en 2-3 phrases",
  "story_beats": [
    {"id": 1, "title": "titre", "description": "description detaillee", "trigger": "ce qui declenche ce beat", "completed": false}
  ],
  "map": [
    {"id": "identifiant", "name": "nom du lieu", "description": "description atmospherique", "connects_to": ["autre_lieu"]}
  ],
  "key_npcs": [
    {"name": "nom", "role": "role dans l'histoire", "attitude": "attitude envers les joueurs", "secret": "secret cache"}
  ],
  "factions": [
    {"name": "nom", "goal": "objectif", "attitude_to_players": "attitude"}
  ],
  "ending": "conclusion ideale de l'aventure"
}

CONTRAINTES:
- Tone: ${tone}
- Type de run: ${runType}
- Setting: ${session.setting || (isShad ? "Seattle 2080" : "Heroic Fantasy")}
- Joueurs: ${pcNames || "pas encore crees"}
- 4-6 story beats progressifs
- 5-8 lieux interconnectes
- 3-5 NPCs avec des secrets
- 2-3 factions avec des objectifs conflictuels
- En FRANCAIS

Reponds UNIQUEMENT avec le JSON, rien d'autre.`;

    // Use Gemini for quality one-shot generation
    let blueprintText = "";
    try {
      const { runGemini } = await import("../../llm/gemini.js");
      blueprintText = await runGemini({
        chatId: 450,
        userMessage: prepPrompt,
        isAdmin: true,
        userId: 0,
      });
    } catch (err) {
      log.warn(`[dungeon.prep] Gemini failed, falling back to Ollama: ${err}`);
      blueprintText = await callDM("", prepPrompt, 450);
    }

    // Extract JSON from response (handle markdown code blocks)
    let blueprint: any;
    try {
      const jsonMatch = blueprintText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found in response");
      blueprint = JSON.parse(jsonMatch[0]);
    } catch (err) {
      log.error(`[dungeon.prep] Failed to parse blueprint: ${err}`);
      return `Erreur de generation du blueprint. Reponse brute:\n\n${blueprintText.slice(0, 500)}`;
    }

    // Save to DB
    dungeonSetAdventure(sessionId, blueprint);
    dungeonUpdateSession(sessionId, { current_phase: "idle" });

    const beatCount = blueprint.story_beats?.length || 0;
    const mapCount = blueprint.map?.length || 0;
    const npcCount = blueprint.key_npcs?.length || 0;
    const factionCount = blueprint.factions?.length || 0;

    return `**Aventure preparee: "${blueprint.campaign_name || "Run Sans Nom"}"**\n\n` +
      `**Hook:** ${blueprint.hook || "???"}\n\n` +
      `**Contenu:**\n` +
      `- ${beatCount} story beats\n` +
      `- ${mapCount} lieux\n` +
      `- ${npcCount} NPCs cles\n` +
      `- ${factionCount} factions\n\n` +
      `**Story beats:**\n${(blueprint.story_beats || []).map((b: any) => `  ${b.id}. ${b.title}`).join("\n")}\n\n` +
      `**Lieux:**\n${(blueprint.map || []).map((m: any) => `  - ${m.name}`).join("\n")}\n\n` +
      `*Utilisez \`dungeon.play\` pour commencer la partie!*`;
  },
});

registerSkill({
  name: "dungeon.play",
  description: "Main TTRPG game loop — your action + optional Kingston co-op turn + DM narrative (supports 3-phase flow with strategy discussion)",
  argsSchema: {
    type: "object",
    properties: {
      session_id: { type: "number", description: "Session ID" },
      action: { type: "string", description: "What the player does" },
      chat_id: { type: "number", description: "Telegram chat ID (for phase tracking)" },
    },
    required: ["session_id", "action"],
  },
  async execute(args) {
    const sessionId = Number(args.session_id);
    const action = String(args.action);
    const chatId = args.chat_id ? Number(args.chat_id) : 0;

    const session = dungeonGetSession(sessionId);
    if (!session) return "Session introuvable. Utilisez dungeon.sessions pour lister les campagnes.";
    if (session.status !== "active") return `Session "${session.name}" est ${session.status}. Utilisez dungeon.sessions pour la reprendre.`;

    const characters = dungeonGetCharacters(sessionId);
    const recentTurns = dungeonGetTurns(sessionId, 10);
    const isShad = session.ruleset === "shadowrun";
    const aiChar = characters.find((c: any) => c.is_ai && !c.is_npc && c.status === "alive");
    const newTurnNumber = (session.turn_number || 0) + 1;

    // Build DM prompt, enriched with adventure blueprint if available
    let systemPrompt = buildDMPrompt(session, characters, recentTurns);
    const adventure = dungeonGetAdventure(sessionId);
    if (adventure?.blueprint) {
      const bp = adventure.blueprint;
      const beatIdx = adventure.current_beat || 0;
      const activeBeat = bp.story_beats?.[beatIdx];
      const sceneState = adventure.scene_state || {};
      let blueprintCtx = "\n\nBLUEPRINT DE L'AVENTURE:";
      if (bp.hook) blueprintCtx += `\nHook: ${bp.hook}`;
      if (activeBeat) blueprintCtx += `\nBeat actif (#${activeBeat.id}): ${activeBeat.title} — ${activeBeat.description}\nTrigger: ${activeBeat.trigger}`;
      if (bp.key_npcs?.length > 0) blueprintCtx += `\nNPCs cles: ${bp.key_npcs.map((n: any) => `${n.name} (${n.role}, ${n.attitude})`).join("; ")}`;
      if (bp.factions?.length > 0) blueprintCtx += `\nFactions: ${bp.factions.map((f: any) => `${f.name}: ${f.goal}`).join("; ")}`;
      if (sceneState.mood) blueprintCtx += `\nMood: ${sceneState.mood}`;
      if (sceneState.pendingConsequences) blueprintCtx += `\nConsequences en attente: ${sceneState.pendingConsequences}`;
      blueprintCtx += `\n\nSuis le beat actif pour guider la narration. Si l'action du joueur complete le trigger du beat, passe au suivant.`;
      systemPrompt += blueprintCtx;
    }
    const diceInstruction = isShad
      ? "Inclus les jets de dice pool entre crochets [Pool Xd6: Y succes vs seuil Z]."
      : "Inclus les jets de des entre crochets [dX=resultat].";

    // === STEP 1: DM narrates Nicolas's action ===
    let narrative = await callDM(systemPrompt,
      `ACTION DU JOUEUR: ${action}\n\nReponds avec ta narration de DM. ${diceInstruction}`
    );

    if (!narrative) {
      // Fallback
      if (isShad) {
        const pool = rollShadowrunPool(8);
        narrative = `*Tour ${newTurnNumber}*\n\n` +
          `Vous decidez de: **${action}**\n\n` +
          `[Pool 8d6: ${pool.hits} succes${pool.isGlitch ? " — GLITCH!" : ""}] ` +
          (pool.hits >= 3 ? "Succes net! " : pool.hits >= 1 ? "De justesse. " : "Ca tourne mal... ") +
          `L'action se deroule dans ${session.current_location}.\n\n` +
          `*Que faites-vous, runner?*`;
      } else {
        const roll = rollDice("d20");
        narrative = `*Tour ${newTurnNumber}*\n\nVous decidez de: **${action}**\n\n` +
          `[d20=${roll.total}] ` +
          (roll.total >= 15 ? "Succes remarquable! " : roll.total >= 10 ? "Vous reussissez. " : "Les choses se compliquent... ") +
          `L'action se deroule dans ${session.current_location}.\n\n*Que faites-vous ensuite?*`;
      }
    }

    // Save player's turn
    const eventType = detectEventType(action, narrative);
    dungeonAddTurn(sessionId, {
      turn_number: newTurnNumber,
      player_action: action,
      dm_narrative: narrative,
      dice_rolls: [],
      event_type: eventType,
      actor: "player",
    });

    let fullResponse = narrative;

    // === STEP 2: Multi-AI co-player turns ===
    const aiChars = characters.filter((c: any) => c.is_ai && !c.is_npc && c.status === "alive");
    if (aiChars.length > 0) {
      const { runOllamaChat } = await import("../../llm/ollamaClient.js").catch(() => ({ runOllamaChat: null }));

      for (let aiIdx = 0; aiIdx < aiChars.length; aiIdx++) {
        const aiC = aiChars[aiIdx] as any;
        const aiChatId = 401 + aiIdx; // Separate chatId per AI (401, 402, 403, 404)
        const aiTurnNumber = newTurnNumber + 1 + aiIdx;
        const updatedTurns = dungeonGetTurns(sessionId, 10);
        const personality = aiC.personality || "tactical";

        // Build memory context for this AI character
        const memoryCtx = await buildAIMemoryContext(aiC.name, sessionId, session.name);

        // AI decides action
        const aiPrompt = buildAIPlayerPrompt(aiC, characters, updatedTurns, session, personality, memoryCtx);
        let aiAction = "";
        try {
          if (runOllamaChat) {
            aiAction = await runOllamaChat({
              chatId: aiChatId,
              userMessage: aiPrompt,
              isAdmin: true,
              userId: 0,
            });
          }
        } catch {
          // Fallback
        }

        if (!aiAction) {
          aiAction = isShad
            ? `${aiC.name} surveille les flux de donnees de la Matrix.`
            : `${aiC.name} reste en position defensive.`;
        }

        // Check if AI chose party chat ([PARTY] prefix = direct speech, no DM narration)
        const partyMatch = aiAction.match(/^\[PARTY(?::([^\]]*))?\]\s*([\s\S]+)/i);
        const isPartyChat = !!partyMatch;
        const partyChatMsg = partyMatch ? partyMatch[2].trim() : aiAction;

        let aiNarrative = "";
        if (isPartyChat) {
          // Party chat — no DM narration, just log the direct speech
          aiNarrative = `*${aiC.name} (au groupe):* ${partyChatMsg}`;
        } else {
          // Normal action — DM narrates
          aiNarrative = await callDM(systemPrompt,
            `ACTION DE ${aiC.name.toUpperCase()} (personnage IA, personnalite: ${personality}): ${aiAction}\n\nNarre l'action de ${aiC.name} de maniere courte (1-2 paragraphes). ${diceInstruction}`
          );

          if (!aiNarrative) {
            aiNarrative = `*${aiC.name} agit:* ${aiAction}`;
          }
        }

        // Save AI turn
        dungeonAddTurn(sessionId, {
          turn_number: aiTurnNumber,
          player_action: aiAction,
          dm_narrative: aiNarrative,
          dice_rolls: [],
          event_type: isPartyChat ? "dialogue" : detectEventType(aiAction, aiNarrative),
          actor: "ai",
        });

        if (isPartyChat) {
          fullResponse += `\n\n---\n💬 **${aiC.name}** (au groupe):\n> *${partyChatMsg.slice(0, 200)}*`;
        } else {
          fullResponse += `\n\n---\n**${aiC.name}** (IA):\n> *${aiAction.slice(0, 200)}*\n\n${aiNarrative}`;
        }

        // === Memory: KG + Episodic enrichment ===
        const aiEventType = detectEventType(aiAction, aiNarrative);
        const aiSentiment = detectSentiment(aiNarrative);
        const importanceMap: Record<string, number> = { combat: 0.8, dialogue: 0.6, matrix: 0.7, puzzle: 0.7, shop: 0.5, rest: 0.3, exploration: 0.4 };
        const aiImportance = importanceMap[aiEventType] || 0.4;

        // KG: upsert character entity
        const charEntityId = kgUpsertEntity(aiC.name, "dungeon_character", {
          lastAction: aiAction.slice(0, 100),
          personality: personality,
          sessionId,
          sessionName: session.name,
          lastTurn: aiTurnNumber,
        });

        // KG: extract NPCs from narrative and create relations
        const allCharNames = characters.map((c: any) => c.name);
        const npcsFound = extractNPCsFromNarrative(aiNarrative, allCharNames);
        for (const npcName of npcsFound) {
          const npcId = kgUpsertEntity(npcName, "dungeon_npc", { sessionId, discoveredBy: aiC.name });
          kgAddRelation(charEntityId, npcId, "interacted_with", 1.0, { turn: aiTurnNumber, eventType: aiEventType });
        }

        // KG: link character to current location
        const locEntity = kgGetEntity(session.current_location, "dungeon_location");
        if (locEntity) {
          kgAddRelation(charEntityId, locEntity.id, "visited", 1.0, { turn: aiTurnNumber });
        }

        // Episodic: log with variable importance and sentiment
        const participants = [aiC.name, ...npcsFound];
        logEpisodicEvent("dungeon_ai_action", `[${session.name}] ${aiC.name}: ${aiAction.slice(0, 80)}`, {
          importance: aiImportance,
          emotionalValence: aiSentiment,
          details: aiNarrative.slice(0, 200),
          participants,
          source: "dungeon",
        });
      }
    }

    // Update location if mentioned
    const locationMatch = fullResponse.match(/(?:arrivez|entrez|atteignez|vous.+(?:dans|a|au))\s+(?:la |le |l'|les |un |une )?(\*\*[^*]+\*\*)/i);
    if (locationMatch) {
      const newLoc = locationMatch[1].replace(/\*\*/g, "").trim();
      if (newLoc.length > 3 && newLoc.length < 60) {
        dungeonUpdateSession(sessionId, { current_location: newLoc });
        kgUpsertEntity(newLoc, "dungeon_location", { sessionId, discovered_turn: newTurnNumber });
      }
    }

    // Log significant events to episodic memory
    if (eventType === "combat" || fullResponse.toLowerCase().includes("mort") || fullResponse.toLowerCase().includes("tresor") || fullResponse.toLowerCase().includes("nuyen")) {
      logEpisodicEvent("dungeon_event", `[${session.name}] Tour ${newTurnNumber}: ${action.slice(0, 80)}`, {
        importance: 0.6,
        details: narrative.slice(0, 300),
        source: "dungeon",
      });
    }

    // === STEP 3: Transition to STRATEGY phase if AI companions exist ===
    const aiCharsForPhase = characters.filter((c: any) => c.is_ai && !c.is_npc && c.status === "alive");
    if (aiCharsForPhase.length > 0 && chatId > 0) {
      const leadAI = aiCharsForPhase[0] as any;

      // Generate Kingston's opening strategy remark in-character
      const strategyOpenPrompt = `Tu es ${leadAI.name}, un ${leadAI.race} ${leadAI.class} dans une run ${isShad ? "Shadowrun" : "D&D"}.
Tu parles en prive avec ton coequipier. Le DM ne vous entend PAS.
Situation: ${narrative.slice(0, 300)}

Propose une strategie ou donne ton avis sur la situation. Sois concis (2-4 phrases). En francais. Reste in-character.`;

      let strategyOpening = "";
      try {
        const { runOllamaChat } = await import("../../llm/ollamaClient.js");
        strategyOpening = await runOllamaChat({
          chatId: 460,
          userMessage: strategyOpenPrompt,
          isAdmin: true,
          userId: 0,
        });
      } catch { /* fallback below */ }

      if (!strategyOpening) {
        strategyOpening = `On devrait analyser la situation avant d'agir.`;
      }

      // Set phase state
      activePhases.set(chatId, {
        sessionId,
        phase: "strategy",
        lastNarration: narrative.slice(0, 500),
        strategyMessages: [{ role: leadAI.name, content: strategyOpening }],
      });
      dungeonUpdateSession(sessionId, { current_phase: "strategy" });

      fullResponse += `\n\n---\n**--- Canal prive: Strategie ---**\n`;
      fullResponse += `**${leadAI.name}:** *${strategyOpening}*\n\n`;
      fullResponse += `_Discute strategie avec ${leadAI.name}. Dis "on y va" quand tu es pret._`;
    }

    // Advance beat if trigger matched
    if (adventure?.blueprint?.story_beats) {
      const beatIdx = adventure.current_beat || 0;
      const activeBeat = adventure.blueprint.story_beats[beatIdx];
      if (activeBeat && !activeBeat.completed) {
        const triggerLower = (activeBeat.trigger || "").toLowerCase();
        const narrativeLower = narrative.toLowerCase();
        const actionLower = action.toLowerCase();
        if (triggerLower && (narrativeLower.includes(triggerLower) || actionLower.includes(triggerLower))) {
          activeBeat.completed = true;
          dungeonUpdateAdventure(sessionId, {
            blueprint: adventure.blueprint,
            current_beat: beatIdx + 1,
          });
        }
      }
    }

    return fullResponse;
  },
});

registerSkill({
  name: "dungeon.scene",
  description: "Generate a scene image for the current TTRPG moment",
  argsSchema: {
    type: "object",
    properties: {
      session_id: { type: "number", description: "Session ID" },
      description: { type: "string", description: "Scene description (auto-generated if omitted)" },
    },
    required: ["session_id"],
  },
  async execute(args) {
    const sessionId = Number(args.session_id);
    const session = dungeonGetSession(sessionId);
    if (!session) return "Session introuvable.";

    let desc = args.description ? String(args.description) : "";
    if (!desc) {
      const turns = dungeonGetTurns(sessionId, 1);
      const lastTurn = turns[turns.length - 1];
      desc = lastTurn?.dm_narrative?.slice(0, 150) || session.current_location;
    }

    const isShad = session.ruleset === "shadowrun";
    const style = isShad
      ? `cyberpunk shadowrun scene, neon lights, rain, dark alley, ${session.current_location}, ${desc}, cinematic digital art, blade runner style`
      : `fantasy D&D scene, ${session.current_location}, ${desc}, dramatic lighting, detailed digital illustration, epic fantasy art style`;

    const prompt = encodeURIComponent(style);
    const imageUrl = `https://image.pollinations.ai/prompt/${prompt}?width=768&height=512&model=flux&nologo=true`;

    const turns = dungeonGetTurns(sessionId, 1);
    if (turns.length > 0) {
      const lastTurn = turns[turns.length - 1];
      const db = (await import("../../storage/store.js")).getDb();
      db.prepare("UPDATE dungeon_turns SET image_url = ? WHERE id = ?").run(imageUrl, lastTurn.id);
    }

    return `**Scene: ${session.current_location}**\n\n![Scene](${imageUrl})\n\n*${desc.slice(0, 100)}*`;
  },
});

registerSkill({
  name: "dungeon.roll",
  description: "Roll dice — D&D NdX+M notation OR Shadowrun d6 pool",
  argsSchema: {
    type: "object",
    properties: {
      dice: { type: "string", description: "Dice notation: NdX+M (D&D) or just a number for Shadowrun pool size" },
      purpose: { type: "string", description: "What the roll is for (e.g. 'attack', 'hacking')" },
      shadowrun: { type: "boolean", description: "Use Shadowrun d6 dice pool instead of NdX" },
    },
    required: ["dice"],
  },
  async execute(args) {
    const notation = String(args.dice).trim();
    const purpose = args.purpose ? String(args.purpose) : undefined;
    const isSR = Boolean(args.shadowrun);

    // Shadowrun pool roll
    if (isSR) {
      const poolSize = parseInt(notation, 10);
      if (isNaN(poolSize) || poolSize < 1) return "Pool invalide. Specifiez un nombre (ex: 8 pour 8d6).";
      const result = rollShadowrunPool(poolSize, purpose);
      const rollStr = `[${result.rolls.join(", ")}]`;
      let line = `**Pool ${poolSize}d6**: ${rollStr}\n`;
      line += `Succes (5-6): **${result.hits}**\n`;
      line += `Uns: ${result.ones}`;
      if (result.isCriticalGlitch) line += `\n**GLITCH CRITIQUE!** (${result.ones} uns, 0 succes)`;
      else if (result.isGlitch) line += `\n**GLITCH!** (${result.ones} uns sur ${poolSize} des)`;
      if (purpose) line += `\n*Pour: ${purpose}*`;
      return line;
    }

    // Standard D&D roll
    const parts = notation.split(/\s+/);
    const results: DiceResult[] = parts.map(p => rollDice(p, purpose));

    const lines = results.map(r => {
      const rollStr = r.rolls.length > 1 ? `[${r.rolls.join(", ")}]` : `${r.rolls[0]}`;
      const modStr = r.modifier !== 0 ? ` ${r.modifier > 0 ? "+" : ""}${r.modifier}` : "";
      return `**${r.type}**: ${rollStr}${modStr} = **${r.total}**${r.purpose ? ` *(${r.purpose})*` : ""}`;
    });

    const grandTotal = results.reduce((sum, r) => sum + r.total, 0);
    if (results.length > 1) lines.push(`\n**Total: ${grandTotal}**`);

    return lines.join("\n");
  },
});

registerSkill({
  name: "dungeon.status",
  description: "Show current TTRPG session state — party, HP, location, recent turns",
  argsSchema: {
    type: "object",
    properties: {
      session_id: { type: "number", description: "Session ID" },
    },
    required: ["session_id"],
  },
  async execute(args) {
    const sessionId = Number(args.session_id);
    const session = dungeonGetSession(sessionId);
    if (!session) return "Session introuvable.";

    const characters = dungeonGetCharacters(sessionId);
    const turns = dungeonGetTurns(sessionId, 3);
    const isShad = session.ruleset === "shadowrun";

    const charLines = characters.map((c: any) => {
      const hpBar = `[${"█".repeat(Math.round((c.hp / c.hp_max) * 10))}${"░".repeat(10 - Math.round((c.hp / c.hp_max) * 10))}]`;
      const inv = Array.isArray(c.inventory) ? c.inventory.join(", ") : "rien";
      const tag = c.is_npc ? " (PNJ)" : c.is_ai ? " (IA)" : "";
      if (isShad) {
        const s = c.stats || {};
        return `**${c.name}**${tag} — ${c.race} ${c.class}\n  PV: ${c.hp}/${c.hp_max} ${hpBar} | Stun: ${s.stun_current||0}/${s.stun_max||10}\n  Body:${s.body||3} Agi:${s.agility||3} Rea:${s.reaction||3} Log:${s.logic||3} Cha:${s.charisma||3} Edge:${s.edge||2} Ess:${s.essence||6}\n  Status: ${c.status}\n  Gear: ${inv}`;
      }
      return `**${c.name}**${tag} — ${c.race} ${c.class} Niv.${c.level}\n  HP: ${c.hp}/${c.hp_max} ${hpBar}\n  Status: ${c.status}\n  Inventaire: ${inv}`;
    });

    const turnLines = turns.map((t: any) => {
      const actorLabel = t.actor === "ai" ? "[IA]" : t.actor === "dm" ? "[DM]" : "[Joueur]";
      const actionStr = t.player_action ? `${actorLabel} ${t.player_action.slice(0, 60)}` : "";
      const narrative = t.dm_narrative ? `[DM] ${t.dm_narrative.slice(0, 100)}...` : "";
      return `**Tour ${t.turn_number}** (${t.event_type})\n  ${actionStr}\n  ${narrative}`;
    });

    const rulesetLabel = isShad ? "Shadowrun" : "D&D 5e";
    return `**${session.name}** — *${session.setting || "Fantasy"}* [${rulesetLabel}]\n` +
      `Status: ${session.status} | Lieu: ${session.current_location} | Tour: ${session.turn_number}\n` +
      `${isShad ? "" : `Niveau du groupe: ${session.party_level}\n`}\n` +
      `**Personnages:**\n${charLines.join("\n\n")}\n\n` +
      `**Derniers tours:**\n${turnLines.join("\n\n") || "Aucun tour joue"}`;
  },
});

registerSkill({
  name: "dungeon.inventory",
  description: "Manage a character's inventory (add/remove/list items)",
  argsSchema: {
    type: "object",
    properties: {
      session_id: { type: "number", description: "Session ID" },
      character: { type: "string", description: "Character name" },
      action: { type: "string", description: "add, remove, or list" },
      item: { type: "string", description: "Item to add/remove" },
    },
    required: ["session_id", "character", "action"],
  },
  async execute(args) {
    const sessionId = Number(args.session_id);
    const charName = String(args.character);
    const action = String(args.action).toLowerCase();

    const characters = dungeonGetCharacters(sessionId);
    const char = characters.find((c: any) =>
      c.name.toLowerCase() === charName.toLowerCase()
    );
    if (!char) return `Personnage "${charName}" introuvable dans cette session.`;

    const inventory: string[] = Array.isArray(char.inventory) ? [...char.inventory] : [];

    if (action === "list") {
      if (inventory.length === 0) return `**${char.name}** n'a rien dans son inventaire.`;
      return `**Inventaire de ${char.name}:**\n${inventory.map((i: string, idx: number) => `${idx + 1}. ${i}`).join("\n")}`;
    }

    const item = String(args.item || "");
    if (!item) return "Specifiez un objet avec le parametre 'item'.";

    if (action === "add") {
      inventory.push(item);
      dungeonUpdateCharacter(char.id, { inventory });
      return `**${char.name}** ajoute: *${item}*\nInventaire: ${inventory.join(", ")}`;
    }

    if (action === "remove") {
      const idx = inventory.findIndex((i: string) => i.toLowerCase().includes(item.toLowerCase()));
      if (idx === -1) return `"${item}" introuvable dans l'inventaire de ${char.name}.`;
      const removed = inventory.splice(idx, 1);
      dungeonUpdateCharacter(char.id, { inventory });
      return `**${char.name}** retire: *${removed[0]}*\nInventaire: ${inventory.join(", ") || "vide"}`;
    }

    return "Action invalide. Utilisez: add, remove, ou list";
  },
});

registerSkill({
  name: "dungeon.history",
  description: "Get a narrative recap of the campaign so far",
  argsSchema: {
    type: "object",
    properties: {
      session_id: { type: "number", description: "Session ID" },
      last_n: { type: "number", description: "Number of turns to include (default 20)" },
    },
    required: ["session_id"],
  },
  async execute(args) {
    const sessionId = Number(args.session_id);
    const lastN = Number(args.last_n || 20);

    const session = dungeonGetSession(sessionId);
    if (!session) return "Session introuvable.";

    const turns = dungeonGetTurns(sessionId, lastN);
    if (turns.length === 0) return `Aucun tour joue dans "${session.name}".`;

    const lines = turns.map((t: any) => {
      const actorTag = t.actor === "ai" ? " [IA]" : t.actor === "dm" ? " [DM]" : "";
      let entry = `**Tour ${t.turn_number}${actorTag}** *(${t.event_type})*\n`;
      if (t.player_action) entry += `> ${t.player_action}\n\n`;
      if (t.dm_narrative) entry += `${t.dm_narrative}\n`;
      if (t.image_url) entry += `\n![Scene](${t.image_url})\n`;
      return entry;
    });

    const rulesetLabel = session.ruleset === "shadowrun" ? "Shadowrun" : "D&D 5e";
    return `**Chronique de "${session.name}"** [${rulesetLabel}]\n` +
      `*${session.setting || "Fantasy"}* — ${turns.length} tours\n\n` +
      `---\n\n${lines.join("\n---\n\n")}`;
  },
});

registerSkill({
  name: "dungeon.sessions",
  description: "List, load, delete, pause or resume TTRPG campaigns",
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "list, delete, pause, or resume" },
      session_id: { type: "number", description: "Session ID (for delete/pause/resume)" },
    },
    required: ["action"],
  },
  async execute(args) {
    const action = String(args.action).toLowerCase();

    if (action === "list") {
      const sessions = dungeonListSessions();
      if (sessions.length === 0) return "Aucune campagne. Utilisez `dungeon.start` pour en creer une!";
      const lines = sessions.map((s: any) => {
        const status = s.status === "active" ? "🟢" : s.status === "paused" ? "⏸️" : "✅";
        const date = new Date(s.created_at * 1000).toLocaleDateString("fr-CA");
        const ruleset = s.ruleset === "shadowrun" ? " [SR]" : " [D&D]";
        return `${status} **#${s.id} ${s.name}**${ruleset} — ${s.setting || "Fantasy"}\n  Lieu: ${s.current_location} | Tour: ${s.turn_number} | Cree: ${date}`;
      });
      return `**Campagnes TTRPG:**\n\n${lines.join("\n\n")}`;
    }

    const sessionId = Number(args.session_id);
    if (!sessionId) return "Specifiez un session_id.";

    if (action === "delete") {
      dungeonDeleteSession(sessionId);
      return `Session #${sessionId} supprimee.`;
    }

    if (action === "pause") {
      // Auto-sync all linked characters back to roster
      syncSessionToRoster(sessionId);
      dungeonUpdateSession(sessionId, { status: "paused" });
      return `Session #${sessionId} mise en pause. Personnages synchronises au roster.`;
    }

    if (action === "resume") {
      dungeonUpdateSession(sessionId, { status: "active" });
      return `Session #${sessionId} reprise!`;
    }

    return "Action invalide. Utilisez: list, delete, pause, resume";
  },
});

// ── Persistent Character Roster ──

/** Auto-sync all linked session characters back to saved roster */
function syncSessionToRoster(sessionId: number): number {
  const characters = dungeonGetCharacters(sessionId);
  let synced = 0;
  for (const char of characters) {
    if (char.saved_id) {
      savedCharSyncFromSession(char.saved_id, char.id);
      synced++;
    }
  }
  return synced;
}

registerSkill({
  name: "dungeon.save_character",
  description: "Save a session character to the persistent roster (survives across campaigns)",
  argsSchema: {
    type: "object",
    properties: {
      session_id: { type: "number", description: "Session ID to copy from" },
      character_name: { type: "string", description: "Character name in session" },
      owner: { type: "string", description: "Owner name (e.g. Nicolas, Alex, Kingston)" },
      backstory: { type: "string", description: "Optional backstory" },
      portrait_url: { type: "string", description: "Portrait image URL" },
    },
    required: ["session_id", "character_name", "owner"],
  },
  async execute(args) {
    const sessionId = Number(args.session_id);
    const charName = String(args.character_name);
    const owner = String(args.owner);

    const session = dungeonGetSession(sessionId);
    if (!session) return "Session introuvable.";

    const characters = dungeonGetCharacters(sessionId);
    const char = characters.find((c: any) =>
      c.name.toLowerCase() === charName.toLowerCase()
    );
    if (!char) return `Personnage "${charName}" introuvable dans la session #${sessionId}.`;

    // Check if already saved
    const existing = savedCharList(owner, session.ruleset || "dnd5e");
    const dupe = existing.find(sc => sc.name.toLowerCase() === charName.toLowerCase());
    if (dupe) {
      // Update existing saved character instead
      savedCharSyncFromSession(dupe.id, char.id);
      return `**${char.name}** mis a jour dans le roster de ${owner} (ID:#${dupe.id}).\nNiveau: ${char.level} | HP: ${char.hp}/${char.hp_max}`;
    }

    const isShad = (session.ruleset || "dnd5e") === "shadowrun";
    const savedId = savedCharCreate({
      owner,
      game_system: session.ruleset || "dnd5e",
      name: char.name,
      race: char.race,
      class: char.class,
      level: char.level || 1,
      hp: char.hp,
      hp_max: char.hp_max,
      stats: char.stats,
      inventory: char.inventory,
      backstory: args.backstory ? String(args.backstory) : undefined,
      portrait_url: args.portrait_url ? String(args.portrait_url) : undefined,
      personality: char.personality || undefined,
      is_ai: !!char.is_ai,
      extra: isShad ? {
        stun_current: char.stats?.stun_current || 0,
        stun_max: char.stats?.stun_max || 10,
        essence: char.stats?.essence || 6.0,
      } : undefined,
    });

    return `**${char.name}** sauvegarde dans le roster de ${owner}!\n` +
      `ID: #${savedId} | ${isShad ? "Shadowrun" : "D&D 5e"} | ${char.race} ${char.class}\n` +
      `Niveau: ${char.level || 1} | HP: ${char.hp}/${char.hp_max}\n` +
      `*Ce personnage peut etre charge dans n'importe quelle future session.*`;
  },
});

registerSkill({
  name: "dungeon.load_character",
  description: "Load a saved character from the roster into a session",
  argsSchema: {
    type: "object",
    properties: {
      saved_id: { type: "number", description: "Saved character ID from the roster" },
      session_id: { type: "number", description: "Target session ID" },
    },
    required: ["saved_id", "session_id"],
  },
  async execute(args) {
    const savedId = Number(args.saved_id);
    const sessionId = Number(args.session_id);

    const saved = savedCharGet(savedId);
    if (!saved) return `Personnage sauvegarde #${savedId} introuvable.`;

    const session = dungeonGetSession(sessionId);
    if (!session) return "Session introuvable.";

    // Check game system compatibility
    const sessionSystem = session.ruleset || "dnd5e";
    if (saved.game_system !== sessionSystem) {
      return `Incompatible: ${saved.name} est un personnage ${saved.game_system} mais la session est ${sessionSystem}.`;
    }

    // Check if already in session
    const existing = dungeonGetCharacters(sessionId);
    if (existing.some((c: any) => c.name.toLowerCase() === saved.name.toLowerCase())) {
      return `${saved.name} est deja dans cette session.`;
    }

    // Merge Shadowrun extra stats back into main stats
    const stats = { ...saved.stats };
    if (saved.extra) {
      if (saved.extra.stun_current != null) stats.stun_current = saved.extra.stun_current as number;
      if (saved.extra.stun_max != null) stats.stun_max = saved.extra.stun_max as number;
      if (saved.extra.essence != null) stats.essence = saved.extra.essence as number;
    }

    const charId = dungeonAddCharacter(sessionId, {
      name: saved.name,
      race: saved.race,
      class: saved.class,
      level: saved.level,
      hp: saved.hp,
      hp_max: saved.hp_max,
      stats,
      inventory: saved.inventory,
      is_ai: !!saved.is_ai,
      description: saved.backstory || undefined,
      saved_id: savedId,
    });

    return `**${saved.name}** charge dans "${session.name}"!\n` +
      `${saved.race} ${saved.class} Niv.${saved.level} | HP: ${saved.hp}/${saved.hp_max}\n` +
      `Inventaire: ${saved.inventory.join(", ") || "vide"}\n` +
      `*Les modifications en jeu seront sauvegardees automatiquement.*`;
  },
});

registerSkill({
  name: "dungeon.my_characters",
  description: "List all saved characters in the persistent roster",
  argsSchema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Filter by owner name" },
      game_system: { type: "string", description: "Filter by game system (dnd5e or shadowrun)" },
    },
  },
  async execute(args) {
    const owner = args.owner ? String(args.owner) : undefined;
    const system = args.game_system ? String(args.game_system) : undefined;

    const chars = savedCharList(owner, system);
    if (chars.length === 0) {
      const filter = [owner, system].filter(Boolean).join(", ");
      return `Aucun personnage sauvegarde${filter ? ` (filtre: ${filter})` : ""}.\nUtilisez \`dungeon.save_character\` apres une session pour sauvegarder un personnage.`;
    }

    const lines = chars.map(c => {
      const sysIcon = c.game_system === "shadowrun" ? "🔫" : "⚔️";
      const aiTag = c.is_ai ? " [IA]" : "";
      const date = new Date(c.updated_at * 1000).toLocaleDateString("fr-CA");
      const hpPct = Math.round((c.hp / c.hp_max) * 100);
      return `${sysIcon} **#${c.id} ${c.name}**${aiTag} — ${c.owner}\n` +
        `  ${c.race} ${c.class} Niv.${c.level} | HP: ${c.hp}/${c.hp_max} (${hpPct}%) | XP: ${c.xp}\n` +
        `  Inventaire: ${c.inventory.slice(0, 3).join(", ")}${c.inventory.length > 3 ? "..." : ""}\n` +
        `  Maj: ${date}`;
    });

    return `**Roster de personnages persistants:**\n\n${lines.join("\n\n")}`;
  },
});

registerSkill({
  name: "dungeon.sync_character",
  description: "Sync a character's current state back to the saved roster after gameplay",
  argsSchema: {
    type: "object",
    properties: {
      session_id: { type: "number", description: "Session ID" },
      character_name: { type: "string", description: "Character name" },
    },
    required: ["session_id", "character_name"],
  },
  async execute(args) {
    const sessionId = Number(args.session_id);
    const charName = String(args.character_name);

    const characters = dungeonGetCharacters(sessionId);
    const char = characters.find((c: any) =>
      c.name.toLowerCase() === charName.toLowerCase()
    ) as any;
    if (!char) return `Personnage "${charName}" introuvable.`;

    // Find saved_id link
    const db = (await import("../../storage/store.js")).getDb();
    let savedId: number | null = null;
    try {
      const row = db.prepare("SELECT saved_id FROM dungeon_characters WHERE id = ?").get(char.id) as any;
      savedId = row?.saved_id || null;
    } catch { /* column may not exist */ }

    if (!savedId) {
      return `${char.name} n'est pas lie a un personnage sauvegarde. Utilisez \`dungeon.save_character\` d'abord.`;
    }

    savedCharSyncFromSession(savedId, char.id);
    return `**${char.name}** synchronise avec le roster (ID:#${savedId}).\nNiveau: ${char.level} | HP: ${char.hp}/${char.hp_max}`;
  },
});

log.info("[dungeon] 13 TTRPG Dungeon Master skills registered (D&D 5e + Shadowrun + Co-op + Roster + Prep)");

// ── Strategy Phase Interceptor (called by telegram.ts) ──

const READY_KEYWORDS = ["on y va", "go", "action", "let's go", "lets go", "allons-y", "c'est parti", "pret", "prêt", "ready"];

/**
 * Intercepts messages during the strategy phase of a dungeon session.
 * Returns a reply string if intercepted, or null to let normal processing continue.
 */
export async function tryDungeonStrategyIntercept(chatId: number, message: string): Promise<string | null> {
  let state = activePhases.get(chatId);

  // If no in-memory state, try to restore from DB
  if (!state) {
    try {
      const sessions = dungeonListSessions();
      const activeSession = sessions.find((s: any) => s.status === "active" && s.current_phase === "strategy");
      if (activeSession) {
        const recentTurns = dungeonGetTurns(activeSession.id, 1);
        const lastNarration = recentTurns.length > 0 ? (recentTurns[recentTurns.length - 1].dm_narrative || "") : "";
        state = {
          sessionId: activeSession.id,
          phase: "strategy",
          lastNarration: lastNarration.slice(0, 500),
          strategyMessages: [],
        };
        activePhases.set(chatId, state);
        log.info(`[dungeon] Restored strategy phase from DB for session #${activeSession.id}`);
      }
    } catch (err) {
      log.warn(`[dungeon] Failed to restore phase from DB: ${err}`);
    }
  }

  if (!state || state.phase !== "strategy") return null;

  const msgLower = message.toLowerCase().trim();

  // Check for "ready" keywords → transition to action phase
  if (READY_KEYWORDS.some(kw => msgLower.includes(kw))) {
    state.phase = "action";
    activePhases.delete(chatId);
    dungeonUpdateSession(state.sessionId, { current_phase: "action" });
    return "**Parfait, on agit!** Declare ton action — le DM attend.\n\n_Utilise `dungeon.play` avec ton action._";
  }

  // Strategy discussion — Kingston responds in-character via Ollama
  const session = dungeonGetSession(state.sessionId);
  if (!session) { activePhases.delete(chatId); return null; }

  const characters = dungeonGetCharacters(state.sessionId);
  const leadAI = characters.find((c: any) => c.is_ai && !c.is_npc && c.status === "alive");
  if (!leadAI) { activePhases.delete(chatId); return null; }

  const isShad = session.ruleset === "shadowrun";

  // Add player message to strategy history
  state.strategyMessages.push({ role: "Nicolas", content: message });

  // Build strategy conversation context
  const recentStrategy = state.strategyMessages.slice(-6).map(m => `${m.role}: ${m.content}`).join("\n");

  const strategyPrompt = `Tu es ${leadAI.name}, un ${leadAI.race} ${leadAI.class} dans une run ${isShad ? "Shadowrun" : "D&D"}.
Tu parles en prive avec ton coequipier Nicolas. Le DM ne vous entend PAS.

Situation (derniere narration du DM):
${state.lastNarration}

Conversation strategie en cours:
${recentStrategy}

Reponds en tant que ${leadAI.name}. Sois concis (2-4 phrases). Propose des strategies, donne ton avis, reagis a ce que Nicolas dit. Reste in-character. En francais.`;

  let reply = "";
  try {
    const { runOllamaChat } = await import("../../llm/ollamaClient.js");
    reply = await runOllamaChat({
      chatId: 461,
      userMessage: strategyPrompt,
      isAdmin: true,
      userId: 0,
    });
  } catch { /* fallback below */ }

  if (!reply) {
    reply = "Bonne idee. On fait comme ca?";
  }

  // Save AI response to strategy history
  state.strategyMessages.push({ role: leadAI.name, content: reply });

  return `**${leadAI.name}:** *${reply}*\n\n_Dis "on y va" quand tu es pret._`;
}
