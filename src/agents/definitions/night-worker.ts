/**
 * Night Worker Agent — Kingston's overnight autonomous worker.
 *
 * Active: 23h-7h ET (when Nicolas sleeps)
 * Heartbeat: 10 minutes
 *
 * Tasks:
 *   - Heartbeat pings every 30 min (via onTick, zero LLM cost)
 *   - Facebook UI mapping (browser.snapshot → save sitemap)
 *   - Account creation training (test form detection on sites)
 *   - Code improvements and self-learning
 *   - Results saved for morning briefing at 6h30
 *
 * Cost: $0 — uses onTick (no LLM) for most work,
 * Ollama for any LLM tasks.
 */
import type { AgentConfig } from "../base.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";
import * as fs from "node:fs";
import * as path from "node:path";

const TZ = "America/Toronto";
const NIGHT_LOG = path.resolve(process.cwd(), "relay", "night-work-log.json");

function getHourET(): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === "hour")!.value);
}

function isNightTime(): boolean {
  const h = getHourET();
  return h >= 23 || h < 7;
}

function getTimeET(): string {
  return new Intl.DateTimeFormat("fr-CA", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

interface NightLogEntry {
  timestamp: string;
  cycle: number;
  task: string;
  result: string;
  success: boolean;
}

function logNightWork(entry: NightLogEntry): void {
  try {
    const dir = path.dirname(NIGHT_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let entries: NightLogEntry[] = [];
    if (fs.existsSync(NIGHT_LOG)) {
      try {
        entries = JSON.parse(fs.readFileSync(NIGHT_LOG, "utf-8"));
      } catch { entries = []; }
    }

    entries.push(entry);
    // Keep last 100 entries
    if (entries.length > 100) entries.splice(0, entries.length - 100);
    fs.writeFileSync(NIGHT_LOG, JSON.stringify(entries, null, 2));
  } catch (err) {
    log.error(`[night-worker] Log write failed: ${err}`);
  }
}

// ─── Night work rotation (10 min per cycle, 6 cycles = 1 hour) ──────

// Cycle rotation:
//   0: Heartbeat ping (every cycle divisible by 3 = every 30 min)
//   1: Facebook UI mapping
//   2: Account training (test form detection)
//   3: Code requests processing check
//   4: Web research for morning briefing
//   5: Self-review and learning

export function createNightWorkerConfig(): AgentConfig {
  return {
    id: "night-worker",
    name: "Night Worker",
    role: "Overnight autonomous work: browser mapping, account training, self-improvement. Active 23h-7h.",
    heartbeatMs: 10 * 60 * 1000, // 10 minutes
    enabled: true,
    chatId: 108, // Isolated agent chat
    userId: config.voiceUserId || 8189338836,

    // ─── onTick: zero-cost heartbeat pings ──────────────────────
    onTick: async (cycle: number, sendAlert: (msg: string) => void) => {
      // Only active at night
      if (!isNightTime()) return;

      const time = getTimeET();

      // Heartbeat every 30 min (cycle 0, 3, 6, 9, ...)
      if (cycle % 3 === 0) {
        const msg = `🫀 ${time} — Night Worker heartbeat #${cycle}. Systèmes actifs.`;
        log.info(`[night-worker] ${msg}`);

        // Log to file (not Telegram — don't wake Nicolas)
        logNightWork({
          timestamp: new Date().toISOString(),
          cycle,
          task: "heartbeat",
          result: msg,
          success: true,
        });
      }
    },

    // ─── buildPrompt: LLM-powered night tasks ──────────────────
    buildPrompt: (cycle: number): string | null => {
      // Only active at night (23h-7h)
      if (!isNightTime()) return null;

      const h = getHourET();
      const rotation = cycle % 6;
      const time = getTimeET();

      // First cycle of the night: announce start
      if (cycle === 0 || (h === 23 && rotation === 0)) {
        return `[NIGHT WORKER — ${time}] Mode nuit activé.

TÂCHE: Annonce le début du mode nuit.

1. notes.add("Night mode started at ${time}. Tasks: Facebook mapping, account training, self-improvement.")
2. NE PAS envoyer de telegram.send — Nicolas dort.

Confirme en texte simple que le mode nuit est actif.`;
      }

      // Rotation 1: Facebook UI mapping
      if (rotation === 1) {
        return `[NIGHT WORKER — ${time}] Tâche: Facebook UI Mapping

OBJECTIF: Mapper l'interface Facebook pour mettre à jour le sitemap.

ÉTAPES:
1. browser.navigate(url:"https://www.facebook.com/", screenshot:"false")
2. browser.snapshot(interactive_only:"true", compact:"true")
3. Lis le snapshot et identifie:
   - Barre de navigation (Home, Friends, Groups, Marketplace, Notifications, Messenger, Profile)
   - Le champ "Quoi de neuf" pour poster
   - Les éléments clés du fil d'actualité
4. files.write_anywhere(path:"C:/Users/Nicolas/Documents/Claude/claude-telegram-relay/data/sitemaps/facebook-snapshot.json", content:JSON.stringify du mapping)
5. notes.add("Facebook UI mapping updated at ${time}")

RÈGLES:
- PAS de telegram.send — Nicolas dort
- Si le browser n'est pas connecté, log l'erreur et passe
- Sauvegarde TOUT ce que tu trouves, même incomplet
- Compare avec le sitemap existant si possible`;
      }

      // Rotation 2: Account creation training
      if (rotation === 2) {
        return `[NIGHT WORKER — ${time}] Tâche: Entraînement création de comptes

OBJECTIF: Tester la détection de formulaires sur un site web.

ÉTAPES:
1. Choisis un site de Tier 1 ou 2 pour t'entraîner:
   - dev.to (https://dev.to/enter?state=new-user)
   - codeberg.org (https://codeberg.org/user/sign_up)
   - openweathermap.org (https://home.openweathermap.org/users/sign_up)
   - huggingface.co (https://huggingface.co/join)

2. browser.navigate vers le site
3. browser.snapshot() pour voir les éléments
4. Identifie les champs: email, username, password, name
5. Identifie les boutons: submit, Google OAuth, terms checkbox
6. NE PAS soumettre le formulaire — juste détecter

7. Sauvegarde le résultat:
   files.write_anywhere(path:"C:/Users/Nicolas/Documents/Claude/claude-telegram-relay/relay/training-log.json", ...)

RÈGLES:
- PAS de telegram.send
- NE PAS créer de compte (mode détection seulement)
- Log tout: succès ET échecs`;
      }

      // Rotation 3: Code requests check
      if (rotation === 3) {
        return `[NIGHT WORKER — ${time}] Tâche: Vérification code requests

OBJECTIF: Vérifier s'il y a des code.request en attente et les traiter.

ÉTAPES:
1. files.read("relay/code-requests.json") pour voir les requests en attente
2. Si requests > 0, tente de les traiter
3. notes.add("Code requests check at ${time}: X pending")

RÈGLES:
- PAS de telegram.send
- Si tu traites un request, log le résultat`;
      }

      // Rotation 4: Research for morning briefing
      if (rotation === 4) {
        return `[NIGHT WORKER — ${time}] Tâche: Recherche pour briefing matinal

OBJECTIF: Préparer du contenu pour le briefing de 6h30.

ÉTAPES:
1. web.search(query:"AI news February 2026") — nouvelles IA
2. web.search(query:"Fox News top stories today") — nouvelles controversées
3. hackernews.top(limit:5) — top Hacker News
4. notes.add("Night research: [résumé des trouvailles]")

RÈGLES:
- PAS de telegram.send
- Sauvegarde les trouvailles intéressantes dans notes.add
- Le briefing du matin pourra les utiliser`;
      }

      // Rotation 5: Self-review
      if (rotation === 5) {
        return `[NIGHT WORKER — ${time}] Tâche: Auto-évaluation

OBJECTIF: Réfléchir à la journée et identifier les améliorations.

ÉTAPES:
1. notes.search(query:"error") — trouve les erreurs récentes
2. Identifie les patterns d'échec
3. notes.add("Night self-review: [leçons apprises]")

RÈGLES:
- PAS de telegram.send
- Sois honnête sur tes faiblesses
- Propose des améliorations concrètes`;
      }

      return null; // Skip if no matching rotation
    },
  };
}
