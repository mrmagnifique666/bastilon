/**
 * Dungeon Master in a Box — Kingston becomes a D&D 5e DM.
 *
 * dungeon.start     — Create a new campaign
 * dungeon.play      — Main game loop (player action → DM narrative)
 * dungeon.scene     — Generate a scene image via Pollinations.ai
 * dungeon.roll      — Roll dice (NdX+M notation)
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
  kgUpsertEntity, kgAddRelation,
  logEpisodicEvent,
} from "../../storage/store.js";

// ── Dice roller ──

interface DiceResult {
  type: string;
  rolls: number[];
  modifier: number;
  total: number;
  purpose?: string;
}

function rollDice(notation: string, purpose?: string): DiceResult {
  // Parse NdX+M or NdX-M or dX
  const match = notation.match(/^(\d*)d(\d+)([+-]\d+)?$/i);
  if (!match) {
    // Simple number
    const num = parseInt(notation, 10);
    if (!isNaN(num)) return { type: notation, rolls: [num], modifier: 0, total: num, purpose };
    return { type: notation, rolls: [0], modifier: 0, total: 0, purpose };
  }
  const count = parseInt(match[1] || "1", 10);
  const sides = parseInt(match[2], 10);
  const modifier = parseInt(match[3] || "0", 10);

  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    rolls.push(crypto.randomInt(1, sides + 1));
  }
  const total = rolls.reduce((a, b) => a + b, 0) + modifier;
  return { type: notation, rolls, modifier, total, purpose };
}

// ── DM System Prompt ──

function buildDMPrompt(session: any, characters: any[], recentTurns: any[]): string {
  const charList = characters
    .filter((c) => !c.is_npc)
    .map((c) => {
      const inv = Array.isArray(c.inventory) ? c.inventory.join(", ") : "rien";
      return `- ${c.name} (${c.race} ${c.class} Niv.${c.level}) HP:${c.hp}/${c.hp_max} Inventaire:[${inv}]`;
    })
    .join("\n");

  const npcs = characters
    .filter((c) => c.is_npc)
    .map((c) => `- ${c.name} (${c.race} ${c.class}) — ${c.description || "PNJ"}`)
    .join("\n");

  const history = recentTurns
    .map((t) => {
      let line = `Tour ${t.turn_number}:`;
      if (t.player_action) line += ` [Joueur] ${t.player_action}`;
      if (t.dm_narrative) line += `\n[DM] ${t.dm_narrative.slice(0, 200)}`;
      return line;
    })
    .join("\n\n");

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

// ── Skills ──

registerSkill({
  name: "dungeon.start",
  description: "Create a new D&D campaign with characters",
  argsSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Campaign name" },
      setting: { type: "string", description: "Campaign setting/theme" },
      characters: { type: "string", description: "Characters as 'Name/Race/Class, ...' e.g. 'Thorin/Nain/Guerrier, Elara/Elfe/Magicienne'" },
    },
    required: ["name"],
  },
  async execute(args) {
    const name = String(args.name);
    const setting = args.setting ? String(args.setting) : "Heroic Fantasy classique";

    // Create session
    const sessionId = dungeonCreateSession(name, setting);

    // Parse and create characters
    const charStr = String(args.characters || "Aventurier/Humain/Guerrier");
    const charDefs = charStr.split(",").map((c) => c.trim());
    const created: string[] = [];

    for (const def of charDefs) {
      const parts = def.split("/").map((p) => p.trim());
      const charName = parts[0] || "Aventurier";
      const race = parts[1] || "Humain";
      const charClass = parts[2] || "Guerrier";

      // HP based on class
      const hpMap: Record<string, number> = {
        guerrier: 12, paladin: 12, barbare: 14,
        magicien: 8, sorcier: 8, mage: 8,
        voleur: 10, roublard: 10, ranger: 12, rodeur: 12,
        clerc: 10, pretre: 10, druide: 10,
        barde: 10, moine: 10, artificier: 10,
      };
      const hp = hpMap[charClass.toLowerCase()] || 10;

      // Random stats (4d6 drop lowest)
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

    // Knowledge Graph entries
    const campaignEntityId = kgUpsertEntity(name, "dungeon_campaign", { setting, sessionId });
    kgUpsertEntity("Taverne du Dragon Endormi", "dungeon_location", { sessionId, description: "Point de depart" });
    const tavernId = kgUpsertEntity("Taverne du Dragon Endormi", "dungeon_location");
    kgAddRelation(campaignEntityId, tavernId, "starts_at");

    // Episodic event
    logEpisodicEvent("campaign_start", `Nouvelle campagne D&D: "${name}" (${setting})`, {
      importance: 0.8,
      details: `Personnages: ${created.join(", ")}`,
      source: "dungeon",
    });

    // Intro narrative
    const intro = `**${name}** — *${setting}*\n\n` +
      `La campagne commence! Vos aventuriers se retrouvent dans la **Taverne du Dragon Endormi**, ` +
      `un lieu chaleureux ou les flammes de la cheminee dansent sur les murs de pierre. ` +
      `L'aubergiste, un vieux nain nomme Grimbald, essuie un verre en vous observant d'un oeil curieux.\n\n` +
      `**Personnages crees:**\n${created.map((c) => `- ${c}`).join("\n")}\n\n` +
      `Session ID: ${sessionId}\n` +
      `*Utilisez \`dungeon.play\` pour commencer l'aventure!*`;

    return intro;
  },
});

registerSkill({
  name: "dungeon.play",
  description: "Main D&D game loop — describe your action, get DM narrative response",
  argsSchema: {
    type: "object",
    properties: {
      session_id: { type: "number", description: "Session ID" },
      action: { type: "string", description: "What the player does" },
    },
    required: ["session_id", "action"],
  },
  async execute(args) {
    const sessionId = Number(args.session_id);
    const action = String(args.action);

    const session = dungeonGetSession(sessionId);
    if (!session) return "Session introuvable. Utilisez dungeon.sessions pour lister les campagnes.";
    if (session.status !== "active") return `Session "${session.name}" est ${session.status}. Utilisez dungeon.sessions pour la reprendre.`;

    const characters = dungeonGetCharacters(sessionId);
    const recentTurns = dungeonGetTurns(sessionId, 10);
    const newTurnNumber = (session.turn_number || 0) + 1;

    // Build DM prompt
    const systemPrompt = buildDMPrompt(session, characters, recentTurns);

    // Try Ollama-chat first, fallback to Groq
    let narrative = "";
    try {
      const { runOllamaChat } = await import("../../llm/ollamaClient.js");
      narrative = await runOllamaChat({
        chatId: 400, // dedicated DM chatId
        userMessage: `${systemPrompt}\n\nACTION DU JOUEUR: ${action}\n\nReponds avec ta narration de DM. Inclus les jets de des entre crochets [dX=resultat].`,
        isAdmin: true,
        userId: 0,
      });
    } catch (ollamaErr) {
      log.warn(`[dungeon] Ollama failed, using inline DM: ${ollamaErr}`);
      // Fallback: simple narrative generation
      const roll = rollDice("d20");
      narrative = `*Tour ${newTurnNumber}*\n\n` +
        `Vous decidez de: **${action}**\n\n` +
        `[d20=${roll.total}] ` +
        (roll.total >= 15 ? "Succes remarquable! " : roll.total >= 10 ? "Vous reussissez. " : "Les choses se compliquent... ") +
        `L'action se deroule dans ${session.current_location}.\n\n` +
        `*Que faites-vous ensuite?*\n- Explorer les environs\n- Parler aux PNJs presents\n- Fouiller la zone`;
    }

    // Parse dice rolls from narrative
    const diceMatches = narrative.match(/\[d\d+=\d+[^\]]*\]/g) || [];
    const diceRolls = diceMatches.map((m) => {
      const match = m.match(/\[d(\d+)=(\d+)/);
      return match ? { type: `d${match[1]}`, result: parseInt(match[2], 10), purpose: m } : null;
    }).filter(Boolean);

    // Detect event type from action/narrative
    let eventType = "exploration";
    const lowerAction = action.toLowerCase();
    const lowerNarrative = narrative.toLowerCase();
    if (lowerAction.includes("attaque") || lowerAction.includes("combat") || lowerNarrative.includes("combat")) eventType = "combat";
    else if (lowerAction.includes("parle") || lowerAction.includes("discute") || lowerAction.includes("dialogue")) eventType = "dialogue";
    else if (lowerAction.includes("enigme") || lowerAction.includes("puzzle")) eventType = "puzzle";
    else if (lowerAction.includes("repos") || lowerAction.includes("dormir")) eventType = "rest";
    else if (lowerAction.includes("achete") || lowerAction.includes("vend") || lowerAction.includes("marchand")) eventType = "shop";

    // Save turn
    dungeonAddTurn(sessionId, {
      turn_number: newTurnNumber,
      player_action: action,
      dm_narrative: narrative,
      dice_rolls: diceRolls,
      event_type: eventType,
    });

    // Update location if mentioned
    const locationMatch = narrative.match(/(?:arrivez|entrez|atteignez|vous.+(?:dans|a))\s+(?:la |le |l'|les |un |une )?(\*\*[^*]+\*\*)/i);
    if (locationMatch) {
      const newLoc = locationMatch[1].replace(/\*\*/g, "").trim();
      if (newLoc.length > 3 && newLoc.length < 60) {
        dungeonUpdateSession(sessionId, { current_location: newLoc });
        kgUpsertEntity(newLoc, "dungeon_location", { sessionId, discovered_turn: newTurnNumber });
      }
    }

    // Log significant events
    if (eventType === "combat" || lowerNarrative.includes("mort") || lowerNarrative.includes("tresor")) {
      logEpisodicEvent("dungeon_event", `[${session.name}] Tour ${newTurnNumber}: ${action.slice(0, 80)}`, {
        importance: 0.6,
        details: narrative.slice(0, 300),
        source: "dungeon",
      });
    }

    return narrative;
  },
});

registerSkill({
  name: "dungeon.scene",
  description: "Generate a scene image for the current D&D moment",
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

    // Build Pollinations.ai prompt
    const prompt = encodeURIComponent(
      `fantasy D&D scene, ${session.current_location}, ${desc}, dramatic lighting, detailed digital illustration, epic fantasy art style`
    );
    const imageUrl = `https://image.pollinations.ai/prompt/${prompt}?width=768&height=512&nologo=true`;

    // Save image URL to the latest turn
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
  description: "Roll dice using standard notation (e.g. 2d6+3, d20, 4d8)",
  argsSchema: {
    type: "object",
    properties: {
      dice: { type: "string", description: "Dice notation: NdX+M (e.g. 2d6+3, d20, 4d8-1)" },
      purpose: { type: "string", description: "What the roll is for (e.g. 'attack', 'damage')" },
    },
    required: ["dice"],
  },
  async execute(args) {
    const notation = String(args.dice).trim();
    const purpose = args.purpose ? String(args.purpose) : undefined;

    // Support multiple dice separated by spaces or +
    const parts = notation.split(/\s+/);
    const results: DiceResult[] = parts.map((p) => rollDice(p, purpose));

    const lines = results.map((r) => {
      const rollStr = r.rolls.length > 1 ? `[${r.rolls.join(", ")}]` : `${r.rolls[0]}`;
      const modStr = r.modifier !== 0 ? ` ${r.modifier > 0 ? "+" : ""}${r.modifier}` : "";
      return `🎲 **${r.type}**: ${rollStr}${modStr} = **${r.total}**${r.purpose ? ` *(${r.purpose})*` : ""}`;
    });

    const grandTotal = results.reduce((sum, r) => sum + r.total, 0);
    if (results.length > 1) {
      lines.push(`\n**Total: ${grandTotal}**`);
    }

    return lines.join("\n");
  },
});

registerSkill({
  name: "dungeon.status",
  description: "Show current D&D session state — party, HP, location, recent turns",
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

    const charLines = characters.map((c: any) => {
      const hpBar = `[${"█".repeat(Math.round((c.hp / c.hp_max) * 10))}${"░".repeat(10 - Math.round((c.hp / c.hp_max) * 10))}]`;
      const inv = Array.isArray(c.inventory) ? c.inventory.join(", ") : "rien";
      const tag = c.is_npc ? " (PNJ)" : "";
      return `**${c.name}**${tag} — ${c.race} ${c.class} Niv.${c.level}\n  HP: ${c.hp}/${c.hp_max} ${hpBar}\n  Status: ${c.status}\n  Inventaire: ${inv}`;
    });

    const turnLines = turns.map((t: any) => {
      const action = t.player_action ? `[Action] ${t.player_action.slice(0, 60)}` : "";
      const narrative = t.dm_narrative ? `[DM] ${t.dm_narrative.slice(0, 100)}...` : "";
      return `**Tour ${t.turn_number}** (${t.event_type})\n  ${action}\n  ${narrative}`;
    });

    return `**${session.name}** — *${session.setting || "Fantasy"}*\n` +
      `Status: ${session.status} | Lieu: ${session.current_location} | Tour: ${session.turn_number}\n` +
      `Niveau du groupe: ${session.party_level}\n\n` +
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
      let entry = `**Tour ${t.turn_number}** *(${t.event_type})*\n`;
      if (t.player_action) entry += `> ${t.player_action}\n\n`;
      if (t.dm_narrative) entry += `${t.dm_narrative}\n`;
      if (t.image_url) entry += `\n![Scene](${t.image_url})\n`;
      return entry;
    });

    return `**Chronique de "${session.name}"**\n` +
      `*${session.setting || "Fantasy"}* — ${turns.length} tours\n\n` +
      `---\n\n${lines.join("\n---\n\n")}`;
  },
});

registerSkill({
  name: "dungeon.sessions",
  description: "List, load, delete, pause or resume D&D campaigns",
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
        return `${status} **#${s.id} ${s.name}** — ${s.setting || "Fantasy"}\n  Lieu: ${s.current_location} | Tour: ${s.turn_number} | Cree: ${date}`;
      });
      return `**Campagnes D&D:**\n\n${lines.join("\n\n")}`;
    }

    const sessionId = Number(args.session_id);
    if (!sessionId) return "Specifiez un session_id.";

    if (action === "delete") {
      dungeonDeleteSession(sessionId);
      return `Session #${sessionId} supprimee.`;
    }

    if (action === "pause") {
      dungeonUpdateSession(sessionId, { status: "paused" });
      return `Session #${sessionId} mise en pause.`;
    }

    if (action === "resume") {
      dungeonUpdateSession(sessionId, { status: "active" });
      return `Session #${sessionId} reprise!`;
    }

    return "Action invalide. Utilisez: list, delete, pause, resume";
  },
});

log.info("[dungeon] 8 D&D Dungeon Master skills registered");
