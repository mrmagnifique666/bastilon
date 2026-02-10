/**
 * Shell safety utilities — escaping and validation for command arguments.
 * Used by all skills that spawn shell commands to prevent command injection.
 */

/**
 * Escape a string for use inside PowerShell single-quoted strings.
 * In PS single-quoted strings, the only special char is ' itself, doubled to ''.
 */
export function escPS(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Escape a string for use inside double-quoted shell arguments.
 * Escapes backslash, double-quote, backtick, and dollar sign.
 */
export function escDQ(s: string): string {
  return s.replace(/[\\"$`]/g, "\\$&");
}

/**
 * Validate a package name for pip/npm/winget.
 * Only allows alphanumeric, @, ., _, /, - characters.
 * Rejects anything that could be a shell metacharacter.
 */
export function isValidPkgName(s: string): boolean {
  return /^[@a-zA-Z0-9._/-]+$/.test(s) && s.length < 200 && !s.includes("..");
}

/**
 * Validate that a string is safe for use as a simple argument (no shell metacharacters).
 * Allows alphanumeric, spaces, dots, dashes, underscores, colons, slashes, backslashes.
 */
export function isSafeArg(s: string): boolean {
  return /^[a-zA-Z0-9 .\-_:\\/]+$/.test(s) && s.length < 500;
}
