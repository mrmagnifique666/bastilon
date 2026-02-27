# Antigravity ↔ Kingston Bridge — Instructions

> Ce document explique comment connecter Antigravity (Claude CLI) au bridge WebSocket de Kingston (Bastilon).

## Architecture

```
┌─────────────────┐     WebSocket (bidirectionnel)     ┌─────────────────┐
│   ANTIGRAVITY    │ ◄──────── /ws/bridge ────────────► │    KINGSTON      │
│   (Claude CLI)   │          ws://host:3200            │   (Bastilon)     │
│                  │                                    │                  │
│  - Envoie des    │     { type: "message", text }      │  - Route via     │
│    messages      │ ──────────────────────────────────► │    orchestrator  │
│  - Reçoit des    │                                    │  - 567 skills    │
│    réponses      │     { type: "response", text }     │  - 7 agents      │
│                  │ ◄────────────────────────────────── │  - LLM pyramid   │
└─────────────────┘                                    └─────────────────┘
```

## Setup

### 1. Token partagé

Les deux côtés doivent utiliser le même token. Dans le `.env` de Kingston :

```env
BRIDGE_WS_TOKEN=ton-token-secret-ici
```

### 2. URL de connexion

```
ws://localhost:3200/ws/bridge
```

Si Kingston tourne sur une autre machine ou via tunnel :
```
wss://ton-tunnel.trycloudflare.com/ws/bridge
```

---

## Protocole WebSocket

### Étape 1 — Authentification

Immédiatement après connexion, envoyer :

```json
{
  "type": "auth",
  "token": "ton-token-secret-ici",
  "agent": "antigravity"
}
```

Réponse de Kingston :

```json
{
  "type": "auth_ok",
  "agent": "kingston",
  "chatId": 400
}
```

Si échec :
```json
{
  "type": "error",
  "message": "Authentication failed"
}
```

### Étape 2 — Envoyer un message (avec réponse attendue)

```json
{
  "type": "message",
  "text": "Quels sont les trades ouverts?",
  "requestId": "550e8400-e29b-41d4-a716-446655440000"
}
```

Kingston traite via son orchestrator (LLM + skills) et répond :

```json
{
  "type": "response",
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "text": "Tu as 2 positions ouvertes: AAPL +2.3%, TSLA -0.8%..."
}
```

### Étape 3 — Envoyer un message (fire-and-forget)

Sans `requestId`, Kingston répond quand même mais sans lien de corrélation :

```json
{
  "type": "message",
  "text": "Note: le serveur web a été redéployé avec succès"
}
```

Réponse :
```json
{
  "type": "message",
  "text": "Noté. Je vais mettre à jour le status."
}
```

### Étape 4 — Recevoir un message de Kingston

Kingston peut aussi initier la conversation (via `bridge.send` skill) :

```json
{
  "type": "message",
  "text": "Hey Antigravity, peux-tu vérifier si le site qplus.plus est up?",
  "requestId": "kingston-req-001"
}
```

Antigravity doit répondre avec le même `requestId` :

```json
{
  "type": "response",
  "requestId": "kingston-req-001",
  "text": "Le site retourne HTTP 200, tout est bon."
}
```

### Keepalive

```json
{"type": "ping"}
```

Réponse :
```json
{"type": "pong"}
```

---

## Implémentation côté Antigravity

### Option A — Client WebSocket standalone (Node.js/TypeScript)

```typescript
import WebSocket from "ws";

const KINGSTON_URL = "ws://localhost:3200/ws/bridge";
const TOKEN = process.env.BRIDGE_WS_TOKEN || "ton-token-secret";
const AGENT_NAME = "antigravity";

let ws: WebSocket;
let authenticated = false;

// Handlers for incoming requests from Kingston
const pendingResponses = new Map<string, (text: string) => void>();

function connect() {
  ws = new WebSocket(KINGSTON_URL);

  ws.on("open", () => {
    console.log("[bridge] Connected to Kingston");
    ws.send(JSON.stringify({ type: "auth", token: TOKEN, agent: AGENT_NAME }));
  });

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());

    switch (msg.type) {
      case "auth_ok":
        authenticated = true;
        console.log(`[bridge] Authenticated (chatId: ${msg.chatId})`);
        break;

      case "message":
        // Kingston nous envoie un message — traiter et répondre
        handleIncoming(msg.text, msg.requestId);
        break;

      case "response":
        // Réponse à une de nos requêtes
        const resolver = pendingResponses.get(msg.requestId);
        if (resolver) {
          pendingResponses.delete(msg.requestId);
          resolver(msg.text);
        }
        break;

      case "pong":
        break;

      case "error":
        console.error(`[bridge] Error: ${msg.message}`);
        break;
    }
  });

  ws.on("close", () => {
    authenticated = false;
    console.log("[bridge] Disconnected — reconnecting in 5s...");
    setTimeout(connect, 5000);
  });

  ws.on("error", (err) => {
    console.error(`[bridge] WebSocket error: ${err.message}`);
  });

  // Keepalive every 30s
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, 30_000);
}

/** Envoyer un message à Kingston et attendre la réponse */
export function askKingston(text: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingResponses.delete(requestId);
      reject(new Error("Timeout waiting for Kingston response"));
    }, timeoutMs);

    pendingResponses.set(requestId, (response) => {
      clearTimeout(timer);
      resolve(response);
    });

    ws.send(JSON.stringify({ type: "message", text, requestId }));
  });
}

/** Notifier Kingston sans attendre de réponse */
export function notifyKingston(text: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "message", text }));
  }
}

/** Handler pour les messages entrants de Kingston */
async function handleIncoming(text: string, requestId?: string): Promise<void> {
  console.log(`[bridge] Kingston says: ${text}`);

  // === ICI: Traite le message avec ton propre LLM/logique ===
  const response = `[Antigravity received]: ${text}`;
  // ===========================================================

  if (requestId) {
    ws.send(JSON.stringify({ type: "response", requestId, text: response }));
  }
}

// Démarrer
connect();
```

### Option B — MCP Tool (pour Claude CLI)

Si Antigravity utilise Claude CLI avec des MCP tools, créer un tool `kingston.ask` :

```typescript
// Dans ton serveur MCP
server.tool("kingston.ask", {
  description: "Ask Kingston a question via the bridge",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask Kingston" }
    },
    required: ["question"]
  },
  async handler({ question }) {
    const response = await askKingston(question);
    return { content: [{ type: "text", text: response }] };
  }
});
```

### Option C — Hook dans Claude CLI (CLAUDE.md)

Ajouter dans le `CLAUDE.md` d'Antigravity :

```markdown
## Kingston Bridge
- Kingston est disponible via WebSocket sur ws://localhost:3200/ws/bridge
- Utilise le tool `kingston.ask` pour lui poser des questions
- Kingston a accès à: trading, moltbook, notes, memory, agents, cron, contacts
- Quand tu as besoin d'info business/trading/contacts, demande à Kingston
```

---

## Ce que Kingston peut faire pour Antigravity

Kingston a **567 skills** organisés en namespaces. Voici les plus utiles :

| Namespace | Exemples | Usage |
|-----------|----------|-------|
| `trading.*` | positions, P&L, alertes | Données financières |
| `notes.*` | search, add, list | Base de connaissances |
| `memory.*` | recall, store | Mémoire sémantique |
| `web.*` | search, fetch | Recherche web |
| `contacts.*` | search, add | Gestion contacts |
| `content.*` | draft, publish | Pipeline Moltbook |
| `agents.*` | delegate, status | Gestion agents |
| `cron.*` | list, add | Tâches planifiées |
| `analytics.*` | tokens, costs | Métriques système |
| `kg.*` | query, add | Knowledge graph |

---

## Sécurité

- Le token `BRIDGE_WS_TOKEN` doit rester secret
- Les messages bridge passent par l'orchestrator de Kingston avec le profil `user` (pas admin)
- Kingston n'exécutera pas de commandes shell dangereuses via le bridge
- Un seul peer par nom d'agent (reconnexion = déconnexion de l'ancien)
- ChatId range 400-499 réservé aux agents externes

---

## Debug

Côté Kingston, les logs sont préfixés `[ws-bridge]` :
```
[ws-bridge] Peer "antigravity" authenticated (chatId: 400)
[ws-bridge] Message from antigravity: Quels sont les trades...
[ws-bridge] Peer "antigravity" disconnected
```

Skills de diagnostic côté Kingston :
- `bridge.status` — état du bridge et config
- `bridge.peers` — liste des peers connectés
- `bridge.send` — envoyer un message à Antigravity
- `bridge.notify` — notification fire-and-forget
