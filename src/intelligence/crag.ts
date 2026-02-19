/**
 * CRAG — Corrective Retrieval-Augmented Generation.
 * Adds a relevance grading step after retrieval. If documents are irrelevant,
 * re-queries with expanded terms or falls back to web search.
 * Based on: Yan et al., "Corrective Retrieval Augmented Generation" (2024)
 */
import { log } from "../utils/log.js";

interface GradedDocument {
  content: string;
  score: number;  // 0-10
  source: string;
}

/**
 * Grade a retrieved document's relevance to the query.
 * Uses keyword overlap + structural heuristics (fast, no LLM call).
 */
export function gradeRelevance(query: string, document: string): number {
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const docLower = document.toLowerCase();

  if (queryWords.length === 0) return 5;

  // Keyword overlap score (0-6)
  const matchCount = queryWords.reduce((sum, w) => sum + (docLower.includes(w) ? 1 : 0), 0);
  const keywordScore = Math.min(6, (matchCount / queryWords.length) * 6);

  // Length penalty — very short docs are less useful (0-2)
  const lengthScore = document.length > 50 ? 2 : document.length > 20 ? 1 : 0;

  // Freshness bonus — documents mentioning dates/numbers get slight boost (0-2)
  const hasDates = /\d{4}[-/]\d{2}/.test(document);
  const freshnessScore = hasDates ? 1 : 0;

  // Exact phrase match bonus
  const phraseBonus = docLower.includes(query.toLowerCase().slice(0, 30)) ? 1 : 0;

  return Math.min(10, Math.round(keywordScore + lengthScore + freshnessScore + phraseBonus));
}

/**
 * Expand a query with synonyms and related terms for re-querying.
 */
export function expandQuery(originalQuery: string): string[] {
  const base = originalQuery.toLowerCase();
  const expansions: string[] = [originalQuery];

  // Add French/English variations
  const frEnMap: Record<string, string> = {
    "chercher": "search", "trouver": "find", "comment": "how to",
    "prix": "price cost", "acheter": "buy purchase",
    "vendre": "sell", "créer": "create make", "envoyer": "send",
    "erreur": "error bug", "problème": "problem issue",
    "trading": "bourse stocks", "marché": "market",
  };

  for (const [fr, en] of Object.entries(frEnMap)) {
    if (base.includes(fr)) {
      expansions.push(originalQuery.replace(new RegExp(fr, "gi"), en));
    }
  }

  // Add without stop words
  const stopWords = new Set(["le", "la", "les", "de", "du", "des", "un", "une", "et", "ou", "à", "en", "pour", "sur", "avec", "dans", "que", "qui", "est", "the", "a", "an", "is", "of", "to", "in", "for", "on"]);
  const withoutStops = originalQuery.split(/\s+/).filter(w => !stopWords.has(w.toLowerCase())).join(" ");
  if (withoutStops !== originalQuery && withoutStops.length > 3) {
    expansions.push(withoutStops);
  }

  return [...new Set(expansions)].slice(0, 3);
}

/**
 * Apply CRAG pipeline to a set of retrieved documents.
 * Returns filtered, high-quality documents + suggestions for re-query if needed.
 */
export function applyCRAG(
  query: string,
  documents: Array<{ content: string; source: string }>,
): {
  goodDocs: GradedDocument[];
  needsRequery: boolean;
  expandedQueries: string[];
  needsWebSearch: boolean;
} {
  // Grade all documents
  const graded: GradedDocument[] = documents.map(d => ({
    content: d.content,
    source: d.source,
    score: gradeRelevance(query, d.content),
  }));

  // Separate by quality
  const goodDocs = graded.filter(d => d.score >= 5).sort((a, b) => b.score - a.score);
  const avgScore = graded.length > 0
    ? graded.reduce((sum, d) => sum + d.score, 0) / graded.length
    : 0;

  const needsRequery = goodDocs.length === 0 && graded.length > 0;
  const needsWebSearch = avgScore < 3 && graded.length > 0;
  const expandedQueries = needsRequery ? expandQuery(query) : [];

  if (needsRequery) {
    log.info(`[crag] Low relevance (avg=${avgScore.toFixed(1)}) — suggesting re-query with ${expandedQueries.length} expansions`);
  }

  return { goodDocs, needsRequery, expandedQueries, needsWebSearch };
}
