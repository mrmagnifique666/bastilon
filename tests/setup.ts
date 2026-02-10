// Test setup — set required env vars before config module loads
process.env["TELEGRAM_BOT_TOKEN"] = "test-token-000";
process.env["TELEGRAM_ALLOWED_USERS"] = "111,222";
process.env["SANDBOX_DIR"] = "./sandbox";
process.env["CLAUDE_BIN"] = "claude";
process.env["CLAUDE_ALLOWED_TOOLS"] =
  "help,notes.*,files.*,web.fetch,system.*,shell.exec,code.*,api.*,db.*,telegram.*";
process.env["MEMORY_TURNS"] = "12";
process.env["RATE_LIMIT_MS"] = "2000";
process.env["MAX_TOOL_CHAIN"] = "5";
process.env["SHELL_TIMEOUT_MS"] = "30000";
process.env["CODE_TIMEOUT_MS"] = "30000";
process.env["LOG_LEVEL"] = "error";
process.env["RELAY_DIR"] = "./relay";
process.env["ADMIN_PASSPHRASE"] = "test-secret";
