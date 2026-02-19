# Kingston — Journal de Session

> Ce fichier est chargé dans TOUS les contextes (Telegram, Voice, CLI, Agents).
> Il permet une mémoire unifiée entre tous les canaux.
> Mis à jour automatiquement par Claude Code et par Kingston lui-même.

## Dernière mise à jour: 2026-02-11 01:00 ET

## Services & Clés API Disponibles
- **Telegram**: @kingston_lev_bot (actif)
- **Claude API**: Max plan, Opus/Sonnet/Haiku (actif)
- **Gemini**: Flash + Live audio (actif)
- **Ollama**: qwen3:14b local (actif)
- **Groq**: llama-3.3-70b (actif, clé configurée)
- **ElevenLabs**: TTS voix Daniel (actif, free tier)
- **Edge TTS**: Microsoft TTS gratuit illimité (actif, fr-FR-HenriNeural)
- **Deepgram**: STT (actif)
- **Brave Search**: (actif)
- **DuckDuckGo**: recherche gratuite (actif)
- **Moltbook**: API sociale (actif, clé: configurée dans .env)
- **Printful**: e-commerce/print-on-demand (actif, clé configurée)
- **Remove.bg**: suppression arrière-plan images (actif, clé configurée)
- **Alpaca**: trading papier (actif)
- **Facebook/Instagram**: page configurée
- **Gmail**: Kingston.orchestrator@gmail.com
- **FTP**: qplus.plus (hébergement web)
- **Twilio**: appels téléphoniques +18198004718

## Améliorations Récentes (par Claude Code)

### 2026-02-11
- **Dashboard complet redesigné** — Layout 3 colonnes style HEC:
  - Sidebar gauche (Dashboard, Agents, Mémoire, Trading, Paramètres)
  - Centre: widgets stats + zone visuelle pour images
  - Droite: panel chat collapsible
- **Mode vocal Local** — Web Speech API STT + Edge TTS ($0/mois)
  - Détection silence 1.5s → envoi auto → réponse vocale
  - Mode Cloud (Gemini Live) toujours disponible
- **Wake word "Computer"** — regex phonétique (computer, ordinateur, computeur)
  - Kingston parle immédiatement au réveil ("Oui?", "Je t'écoute")
- **Edge TTS** — msedge-tts comme TTS par défaut (gratuit, illimité)
  - Fix: toStream() retourne {audioStream}, corrigé
- **Mémoire cross-canal** — Voice voit Telegram, Telegram voit Voice
  - Les 10 derniers tours voice chargés dans Telegram/Ollama
  - Les 20 derniers tours Telegram chargés dans Voice
- **Auto-reconnexion Gemini** — reconnecte automatiquement quand la session expire
- **Affichage riche** — images, markdown, code blocks dans le chat voice
- **Clé Moltbook mise à jour** — nouvelle clé API
- **Clé Remove.bg ajoutée** — clé configurée dans .env

### 2026-02-10
- Heartbeat + Cron engine
- AGI Foundation skills (planner, revenue, client, selfimprove, content)
- Groq dans le model pyramid
- Intelligence Contextuelle v2
- Kingston Mind (agent autonome 4 cycles)
- Knowledge Graph + Episodic Memory + Rules Engine
- Wake Word browser (Picovoice abandonné → Web Speech API)
- 599 skills enregistrés, 7 agents actifs
- bastilon.org v2 mis à jour

## Notes Importantes
- Bastilon v2.0.0, package "bastilon"
- DB: relay.db (PAS relay/bot.db)
- Nicolas: Telegram ID 8189338836, francophone, Gatineau QC
- Agents chatIds: 100-106 (Scout, Analyst, Learner, Executor, Trading, Sentinel, Mind)
- Voice chatId: 5, Dashboard: 2, Scheduler: 1, Emile: 3
