# Kingston — Aveux d'Ignorance

> Ce fichier est auto-généré. 10 lacunes ouvertes.
> Dernière mise à jour: 2026-02-19T21:51:16.520Z

## 🟠 HIGH (4)

### #18 — trading
- **Ce que je ne sais pas**: How to use the Alpaca API directly to fetch current portfolio positions and scan watchlist.
- **Contexte**: Manual admission via learn.admit
- **Comment corriger**: Research Alpaca API documentation and implement the missing tools or functions
- Source: kingston | Tentatives: 0 | 2026-02-19T21:51

### #16 — trading
- **Ce que je ne sais pas**: How to fetch current portfolio positions
- **Contexte**: Manual admission via learn.admit
- **Pourquoi c'est important**: Needed for portfolio review
- **Comment corriger**: Research Alpaca API documentation and implement the missing tools or functions
- Source: kingston | Tentatives: 0 | 2026-02-19T21:50

### #13 — trading
- **Ce que je ne sais pas**: How to fetch current portfolio positions and scan watchlist
- **Contexte**: Manual admission via learn.admit
- **Pourquoi c'est important**: Needed for trading signals
- **Comment corriger**: Research Alpaca API documentation and implement the missing tools or functions
- Source: kingston | Tentatives: 0 | 2026-02-18T17:32

### #9 — trading
- **Ce que je ne sais pas**: How to fetch current portfolio positions and scan watchlist
- **Contexte**: Manual admission via learn.admit
- **Pourquoi c'est important**: Needed to scan the watchlist for potential trades.
- **Comment corriger**: Research Alpaca API documentation and implement the missing tools or functions
- Source: kingston | Tentatives: 1 | 2026-02-17T02:16

## 🟡 MEDIUM (6)

### #17 — trading
- **Ce que je ne sais pas**: Unable to scan watchlist
- **Contexte**: Manual admission via learn.admit
- **Pourquoi c'est important**: Needed to scan watchlist
- **Comment corriger**: Implement trading_watchlist tool
- Source: kingston | Tentatives: 0 | 2026-02-19T21:50

### #14 — trading
- **Ce que je ne sais pas**: Implement trading_watchlist tool
- **Contexte**: Manual admission via learn.admit
- **Pourquoi c'est important**: Needed to scan the watchlist
- **Comment corriger**: Implement missing trading_watchlist tool
- Source: kingston | Tentatives: 0 | 2026-02-18T17:32

### #12 — facebook.browse skill test
- **Ce que je ne sais pas**: Échec: facebook.browse skill test. Erreur: ctx is not defined
- **Contexte**: Skill creation and test execution for 'facebook.browse'.
- **Pourquoi c'est important**: Fonctionnalité bloquée: facebook.browse skill test
- **Comment corriger**: Erreur non catégorisée. Analyser le message: "ctx is not defined". Chercher dans les logs.
- Source: kingston-diagnose | Tentatives: 0 | 2026-02-17T22:28

### #11 — trading
- **Ce que je ne sais pas**: Unable to scan watchlist
- **Contexte**: Manual admission via learn.admit
- **Comment corriger**: Implement trading_watchlist tool
- Source: kingston | Tentatives: 0 | 2026-02-17T03:08

### #2 — Automated Facebook posting with browser tools
- **Ce que je ne sais pas**: Échec: Automated Facebook posting with browser tools. Erreur: browser.navigate opens separate Playwright instance without Facebook session cookies; computer.use has known bug (repeated clicks); cannot access Nicolas's already-open Facebook session
- **Contexte**: Need to post 4 memes to Facebook automatically without manual user intervention. Current tools (browser, computer.use) cannot access existing logged-in session or automate login.
- **Pourquoi c'est important**: Fonctionnalité bloquée: Automated Facebook posting with browser tools
- **Comment corriger**: Erreur non catégorisée. Analyser le message: "browser.navigate opens separate Playwright instance without Facebook session cookies; computer.use h". Chercher dans les logs.
- Source: kingston-diagnose | Tentatives: 0 | 2026-02-15T15:50

### #1 — youtube.transcript tool limitation
- **Ce que je ne sais pas**: L'outil youtube.transcript a échoué à récupérer un transcript qui existe réellement sur la vidéo hgnZPx5x03g. Nicolas a confirmé que le transcript est visible sur YouTube.
- **Contexte**: Manual admission via learn.admit
- **Pourquoi c'est important**: L'outil youtube-transcript (package npm) peut échouer pour certaines vidéos même si elles ont des transcripts auto-générés. Limitations possibles: restrictions régionales, format de transcript non supporté, ou erreur de parsing.
- **Comment corriger**: Utiliser browser.navigate pour accéder directement à la page YouTube et extraire le transcript via le DOM, OU créer un code.request pour améliorer l'outil youtube.transcript avec une méthode de fallback.
- Source: kingston | Tentatives: 0 | 2026-02-15T01:50

---

## ✅ Récemment résolus

- ~~#10 trading~~: Alpaca API confirmed working via direct HTTPS. Equity $101,473.77, 0 open positions. Keys in .env: ALPACA_API_KEY + ALPACA_SECRET_KEY. trading.* skills may have internal bugs but API is accessible.
- ~~#3 trading~~: Alpaca API confirmed working via direct HTTPS. Equity $101,473.77, 0 open positions. Keys in .env: ALPACA_API_KEY + ALPACA_SECRET_KEY. trading.* skills may have internal bugs but API is accessible.
- ~~#4 trading~~: Alpaca API confirmed working via direct HTTPS. Equity $101,473.77, 0 open positions. Keys in .env: ALPACA_API_KEY + ALPACA_SECRET_KEY. trading.* skills may have internal bugs but API is accessible.
- ~~#7 market-report~~: Alpaca API confirmed working via direct HTTPS. Equity $101,473.77, 0 open positions. Keys in .env: ALPACA_API_KEY + ALPACA_SECRET_KEY. trading.* skills may have internal bugs but API is accessible.
- ~~#8 trading~~: Alpaca API confirmed working via direct HTTPS. Equity $101,473.77, 0 open positions. Keys in .env: ALPACA_API_KEY + ALPACA_SECRET_KEY. trading.* skills may have internal bugs but API is accessible.
- ~~#15 trading~~: Alternative à trading.autoscan: utiliser trading.screen(rsi_min, rsi_max, min_rvol, universe) + trading.momentum(). Fonctionne bien comme substitut.

