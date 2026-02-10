/**
 * Dashboard broadcast — pushes real-time events to connected WebSocket clients.
 * Other modules call broadcast() to send events to the dashboard UI.
 */
import { WebSocket } from "ws";

const clients = new Set<WebSocket>();

export function addClient(ws: WebSocket): void {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
}

export function getClientCount(): number {
  return clients.size;
}

export function broadcast(event: string, data: unknown): void {
  if (clients.size === 0) return;
  const msg = JSON.stringify({ event, data, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}
