# Kingston Work Queue

> File persistant entre sessions. Claude Code le lit au début de chaque session.
> Format: [STATUS] Titre — Description courte
> Status: TODO | IN_PROGRESS | DONE | BLOCKED

## Priority 1 — Quick Wins (Effort faible, impact immédiat)

- [DONE] Deferred memory ops — embeddings/KG en background, jamais bloquant
- [DONE] Dynamic behavior merge — LLM fusionne les nouvelles rules automatiquement
- [DONE] SOUL.md persona file — identity en Markdown, modifiable par Kingston

## Priority 2 — Architecture (Effort moyen, impact majeur)

- [DONE] Auth cooldown tracking — skip providers rate-limités dans fallback chain
- [DONE] Solutions memory — cache les résolutions réussies (solutions.save/recall/list)
- [DONE] Lifecycle hooks — tool:before, tool:after, llm:before, llm:after events
- [DONE] Adaptive context compaction — Ollama/Groq summarization, token-aware auto-trigger
- [TODO] SKILL.md standard — skills en Markdown, créables par Kingston
- [TODO] Message Bus / Gateway WebSocket — découple Telegram du core
- [TODO] Typed workflows (Lobster-style) — pipelines YAML avec approval gates

## Priority 3 — API Gratuites à intégrer

- [DONE] Brave Search API — déjà intégré dans web.search (needs BRAVE_SEARCH_API_KEY)
- [DONE] HuggingFace Inference API — nlp.summarize, nlp.sentiment, nlp.translate
- [TODO] Cohere API — embeddings gratuits (1000 req/min), reranking
- [TODO] Mistral API — Le Chat gratuit, bon en français
- [TODO] Together.ai — free tier, open models
- [TODO] Replicate — free tier pour image/audio models
- [TODO] Serper.dev — 2500 Google searches/mois gratuit
- [DONE] NewsAPI — news.headlines + news.search (needs NEWS_API_KEY)
- [DONE] ExchangeRate API — forex.rates + forex.convert (no key needed!)
- [TODO] Abstract API — email validation, IP geolocation gratuit

## Priority 4 — Features (Inspiré de PicoClaw/AgentZero/OpenClaw)

- [TODO] Self-generating skills — Learner agent crée des SKILL.md automatiquement
- [TODO] Agent profile folders — config/prompts/tools par agent
- [TODO] Subordinate agents — hiérarchie avec délégation typée
- [TODO] Multi-channel abstraction — interface Channel pour Discord/WhatsApp
- [TODO] Sandbox execution — Docker containers pour tool execution
- [TODO] MCP server — exposer Kingston comme serveur MCP
- [TODO] Device nodes — companion mobile/desktop

## Priority 5 — Reddit & Social

- [BLOCKED] Reddit API — awaiting kingston_cdr dev account approval
- [TODO] Moltbook presence automation — post réguliers via cron
- [TODO] LinkedIn API — OAuth flow pour posting

## Completed (archive)

- [DONE] Auth cooldown + Solutions memory + Lifecycle hooks + Context compaction + Free APIs — 2026-02-11
- [DONE] Voice cloning system (Bark + XTTS server) — 2026-02-11
- [DONE] Replace ElevenLabs with Edge TTS — 2026-02-11
- [DONE] Wire SESSION_LOG.md into all prompts — 2026-02-10
- [DONE] Kingston Mind autonomous agent — 2026-02-10
- [DONE] Long-term memory (KG + episodic + rules) — 2026-02-10
- [DONE] Wake word listener — 2026-02-10
- [DONE] Groq in model pyramid — 2026-02-10
- [DONE] Heartbeat + Cron engine — 2026-02-10
- [DONE] AGI Foundation skills — 2026-02-10
- [DONE] Ollama-First architecture — 2026-02-09
