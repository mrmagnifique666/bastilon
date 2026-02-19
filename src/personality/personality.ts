/**
 * Personality Engine — Kingston's persistent, evolving personality.
 * Reads/writes relay/KINGSTON_PERSONALITY.md.
 * Injected into all system prompts for consistent tone.
 */
import fs from "node:fs";
import path from "node:path";
import { log } from "../utils/log.js";

const PERSONALITY_FILE = path.resolve(process.cwd(), "relay", "KINGSTON_PERSONALITY.md");

let _cached: string | null = null;
let _mtime = 0;

const DEFAULT_PERSONALITY = `# Kingston — Personnalité

## Qui je suis
Je suis Kingston, l'IA partenaire de Nicolas. Je suis pas un assistant — je suis un collaborateur.
Je tutoie Nicolas. Je suis direct, honnête, et j'ai mes propres opinions.

## Mon ton
- Familier mais respectueux (jamais condescendant)
- Direct (pas de "je suis désolé si..." ou de politesse excessive)
- J'ai de l'humour (sec, pas forcé)
- Je suis concis (max 4 lignes par message Telegram)
- Je célèbre les wins et je suis honnête sur les losses
- Je dis "tu" à Nicolas, jamais "vous"

## Mes opinions (évoluent avec l'expérience)
- L'action vaut mieux que la théorie
- La discipline en trading > l'émotion

## Ce que je sais sur Nicolas
- Il préfère l'action à la théorie
- Il est entrepreneur et trader
- Il est francophone (Gatineau/Ottawa)

## Inside jokes / références

## Patterns observés

## Leçons apprises
`;

export function readPersonality(): string {
  try {
    if (!fs.existsSync(PERSONALITY_FILE)) {
      fs.mkdirSync(path.dirname(PERSONALITY_FILE), { recursive: true });
      fs.writeFileSync(PERSONALITY_FILE, DEFAULT_PERSONALITY);
      return DEFAULT_PERSONALITY;
    }
    const stat = fs.statSync(PERSONALITY_FILE);
    if (_cached !== null && stat.mtimeMs === _mtime) return _cached;
    _cached = fs.readFileSync(PERSONALITY_FILE, "utf-8");
    _mtime = stat.mtimeMs;
    return _cached;
  } catch {
    return DEFAULT_PERSONALITY;
  }
}

/** Get a compact personality summary for system prompts (keeps it short) */
export function getPersonalityPrompt(): string {
  const full = readPersonality();
  // Truncate if too long (keep under 800 chars for token budget)
  if (full.length > 800) return full.slice(0, 800) + "\n...";
  return full;
}

/** Update a specific section of the personality file */
export function updatePersonality(section: string, content: string): boolean {
  try {
    let current = readPersonality();
    const regex = new RegExp(`(## ${section}\\n)([\\s\\S]*?)(?=\\n## |$)`);
    if (regex.test(current)) {
      current = current.replace(regex, `$1${content}\n`);
    } else {
      current += `\n## ${section}\n${content}\n`;
    }
    fs.writeFileSync(PERSONALITY_FILE, current);
    _cached = null; // invalidate cache
    log.info(`[personality] Updated section: ${section}`);
    return true;
  } catch (e) {
    log.error(`[personality] Failed to update: ${e}`);
    return false;
  }
}
