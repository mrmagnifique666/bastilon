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
//   1: Memory consolidation and cleanup
//   2: Knowledge graph maintenance
//   3: Code requests processing check
//   4: Web research for morning briefing
//   5: Self-review and learning
//
// NOTE: browser.* tools are BLOCKED for agents — use only notes/memory/web/files skills

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

      // Rotation 1: Memory consolidation
      if (rotation === 1) {
        return `[NIGHT WORKER — ${time}] Tâche: Consolidation mémoire

OBJECTIF: Nettoyer et consolider la mémoire sémantique.

ÉTAPES:
1. memory.stats() — vérifier l'état de la mémoire
2. memory.consolidate() — fusionner les souvenirs similaires
3. memory.cleanup() — supprimer les doublons et entrées obsolètes
4. notes.add("Night memory consolidation at ${time}: [résultat]")

RÈGLES:
- PAS de telegram.send — Nicolas dort
- Log le nombre d'entrées avant/après`;
      }

      // Rotation 2: Knowledge graph maintenance
      if (rotation === 2) {
        return `[NIGHT WORKER — ${time}] Tâche: Maintenance Knowledge Graph

OBJECTIF: Vérifier et enrichir le graphe de connaissances.

ÉTAPES:
1. kg.stats() — état du KG
2. notes.search(query:"important") — trouver des notes à intégrer dans le KG
3. Si des notes contiennent des relations intéressantes, ajouter au KG
4. notes.add("Night KG maintenance at ${time}: [résultat]")

RÈGLES:
- PAS de telegram.send — Nicolas dort
- PAS de browser.* — interdit pour les agents
- Sois conservateur dans les ajouts au KG`;
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
