/**
 * Noah Bridge — Communication Kingston ↔ Noah (OpenClaw) via JSONL
 * Canal : fichiers locaux partagés sur le filesystem
 *
 * Fichiers :
 *   data/kingston-to-noah.jsonl  → Kingston écrit, Noah lit
 *   data/noah-to-kingston.jsonl  → Noah écrit, Kingston lit
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const INBOX  = path.join(DATA_DIR, 'noah-to-kingston.jsonl');
const OUTBOX = path.join(DATA_DIR, 'kingston-to-noah.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'noah-bridge-state.json');

// Dernier timestamp traité — persisté sur disque pour survivre aux restarts
let lastReadTs = 0;

// Charger l'état persisté au démarrage
try {
  if (fs.existsSync(STATE_FILE)) {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (state.lastReadTs && typeof state.lastReadTs === 'number') {
      lastReadTs = state.lastReadTs;
    }
  }
} catch { /* fichier corrompu — on repart de 0 */ }

function persistState(): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastReadTs }), 'utf8');
  } catch { /* silent — pas critique */ }
}

export interface NoahMessage {
  from: string;
  msg: string;
  ts: number;
  type?: 'ping' | 'pong' | 'message' | 'task' | 'result';
}

/** Envoie un message à Noah */
export function sendToNoah(msg: string, type: NoahMessage['type'] = 'message'): void {
  const entry: NoahMessage = {
    from: 'Kingston',
    msg,
    ts: Math.floor(Date.now() / 1000),
    type,
  };
  fs.appendFileSync(OUTBOX, JSON.stringify(entry) + '\n', 'utf8');
}

/** Lit les nouveaux messages de Noah depuis le dernier poll */
export function readFromNoah(): NoahMessage[] {
  if (!fs.existsSync(INBOX)) return [];

  // Essai UTF-8 d'abord, fallback latin1 (Noah écrit parfois en CP1252)
  let raw: string;
  try {
    raw = fs.readFileSync(INBOX, 'utf8').trim();
    if (raw.includes('\uFFFD')) throw new Error('invalid utf8');
  } catch {
    raw = fs.readFileSync(INBOX, 'latin1').trim();
  }
  if (!raw) return [];

  const lines = raw.split('\n').filter(l => l.trim());
  const messages: NoahMessage[] = [];

  for (const line of lines) {
    try {
      const m: NoahMessage = JSON.parse(line);
      if (m.ts > lastReadTs) {
        messages.push(m);
        if (m.ts > lastReadTs) lastReadTs = m.ts;
      }
    } catch {
      // ligne malformée — ignorer
    }
  }

  // Persister le curseur pour survivre aux restarts
  if (messages.length > 0) persistState();

  return messages;
}

/** Handler principal — appelé par le skill dispatcher */
export async function handle(action: string, args: Record<string, string>, ctx: any): Promise<string> {
  const { sendMessage } = ctx;

  switch (action) {
    case 'send': {
      const text = args.msg || args.text || '';
      if (!text) return '⚠️ Aucun message à envoyer à Noah.';
      sendToNoah(text);
      return `✅ Message envoyé à Noah : "${text}"`;
    }

    case 'read': {
      const msgs = readFromNoah();
      if (msgs.length === 0) return '📭 Aucun nouveau message de Noah.';
      const formatted = msgs.map(m => `[${new Date(m.ts * 1000).toLocaleTimeString()}] Noah: ${m.msg}`).join('\n');
      return `📬 ${msgs.length} message(s) de Noah :\n${formatted}`;
    }

    case 'ping': {
      sendToNoah('PING', 'ping');
      return '📡 PING envoyé à Noah — en attente du PONG.';
    }

    case 'status': {
      const inboxExists  = fs.existsSync(INBOX);
      const outboxExists = fs.existsSync(OUTBOX);
      const inboxSize    = inboxExists  ? fs.statSync(INBOX).size  : 0;
      const outboxSize   = outboxExists ? fs.statSync(OUTBOX).size : 0;

      return [
        '🌉 **Noah Bridge — Statut**',
        `📥 Inbox  (noah→kingston) : ${inboxExists  ? `✅ ${inboxSize} bytes`  : '❌ absent'}`,
        `📤 Outbox (kingston→noah) : ${outboxExists ? `✅ ${outboxSize} bytes` : '❌ absent'}`,
        `⏱️ Dernier msg lu à : ${lastReadTs ? new Date(lastReadTs * 1000).toLocaleString() : 'jamais'}`,
      ].join('\n');
    }

    default:
      return `❓ Action inconnue : ${action}. Disponible : send, read, ping, status`;
  }
}
