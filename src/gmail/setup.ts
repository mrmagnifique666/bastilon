/**
 * One-time Gmail OAuth2 setup script.
 * Run: npm run gmail:auth
 *
 * Opens a browser for Google sign-in, receives the OAuth code via a local
 * HTTP server, exchanges it for tokens, and saves them.
 */
import http from "node:http";
import { loadCredentials, createOAuth2Client, saveToken, SCOPES } from "./auth.js";

const PORT = 3456;

async function main() {
  console.log("[gmail:auth] Loading credentials...");
  const credentials = loadCredentials();
  const oauth2Client = createOAuth2Client(credentials, `http://localhost:${PORT}`);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log(`\n[gmail:auth] Open this URL in your browser:\n\n  ${authUrl}\n`);

  // Try to open browser automatically
  const { exec } = await import("node:child_process");
  const cmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  exec(`${cmd} "${authUrl}"`);

  // Wait for the OAuth callback
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost:${PORT}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>Error: ${error}</h1><p>You can close this tab.</p>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Google auth successful!</h1><p>Gmail + Calendar authorized. You can close this tab.</p>");
        server.close();
        resolve(code);
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(PORT, () => {
      console.log(`[gmail:auth] Waiting for OAuth callback on http://localhost:${PORT}...`);
    });

    server.on("error", (err) => {
      reject(new Error(`Failed to start callback server on port ${PORT}: ${err.message}`));
    });
  });

  console.log("[gmail:auth] Received authorization code, exchanging for token...");
  const { tokens } = await oauth2Client.getToken(code);
  saveToken(tokens as Record<string, unknown>);
  console.log("[gmail:auth] Done! Token saved. Kingston can now access Gmail + Calendar.");
}

main().catch((err) => {
  console.error("[gmail:auth] Failed:", err.message);
  process.exit(1);
});
