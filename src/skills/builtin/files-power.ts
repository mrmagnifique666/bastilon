/**
 * PowerShell-based file operations — zip, diff, find, bulk rename, checksum, dir size, permissions.
 */
import { execSync } from "node:child_process";
import { registerSkill } from "../loader.js";
import { escPS } from "../../utils/shell.js";

function ps(cmd: string, timeout = 30_000): string {
  return execSync(`powershell -NoProfile -Command "${cmd.replace(/"/g, '\\"')}"`, {
    encoding: "utf-8",
    timeout,
    maxBuffer: 1024 * 1024,
  }).toString().trim();
}

// ── Zip / Unzip ──────────────────────────────────────────────

registerSkill({
  name: "files.zip",
  description: "Create or extract zip archives.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "compress | extract" },
      source: { type: "string", description: "Source path (file/folder to compress, or zip to extract)" },
      destination: { type: "string", description: "Destination path" },
    },
    required: ["action", "source", "destination"],
  },
  async execute(args) {
    const action = args.action as string;
    const source = args.source as string;
    const dest = args.destination as string;
    if (action === "compress") {
      ps(`Compress-Archive -Path '${escPS(source)}' -DestinationPath '${escPS(dest)}' -Force`);
      return `Compressed: ${source} → ${dest}`;
    } else if (action === "extract") {
      ps(`Expand-Archive -Path '${escPS(source)}' -DestinationPath '${escPS(dest)}' -Force`);
      return `Extracted: ${source} → ${dest}`;
    }
    return "Unknown action. Use: compress, extract";
  },
});

// ── File Diff ────────────────────────────────────────────────

registerSkill({
  name: "files.diff",
  description: "Compare two text files and show differences.",
  argsSchema: {
    type: "object",
    properties: {
      file1: { type: "string", description: "First file path" },
      file2: { type: "string", description: "Second file path" },
    },
    required: ["file1", "file2"],
  },
  async execute(args) {
    try {
      return ps(`Compare-Object (Get-Content '${escPS(String(args.file1))}') (Get-Content '${escPS(String(args.file2))}') | Format-Table -AutoSize SideIndicator, InputObject`);
    } catch {
      return "Files are identical or an error occurred.";
    }
  },
});

// ── Advanced Find ────────────────────────────────────────────

registerSkill({
  name: "files.find",
  description: "Find files by name pattern, size, or modification date.",
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to search in" },
      pattern: { type: "string", description: "Name pattern (e.g. '*.log', 'report*')" },
      minSizeMB: { type: "number", description: "Minimum file size in MB" },
      maxSizeMB: { type: "number", description: "Maximum file size in MB" },
      modifiedAfter: { type: "string", description: "Modified after date (YYYY-MM-DD)" },
      modifiedBefore: { type: "string", description: "Modified before date (YYYY-MM-DD)" },
      maxResults: { type: "number", description: "Maximum results (default 50)" },
    },
    required: ["path"],
  },
  async execute(args) {
    const p = args.path as string;
    const pattern = args.pattern as string;
    const max = (args.maxResults as number) || 50;
    const filters: string[] = [];
    if (pattern) filters.push(`$_.Name -like '${escPS(pattern)}'`);
    if (args.minSizeMB) filters.push(`$_.Length -ge ${Number(args.minSizeMB) * 1024 * 1024}`);
    if (args.maxSizeMB) filters.push(`$_.Length -le ${Number(args.maxSizeMB) * 1024 * 1024}`);
    if (args.modifiedAfter) filters.push(`$_.LastWriteTime -ge '${escPS(String(args.modifiedAfter))}'`);
    if (args.modifiedBefore) filters.push(`$_.LastWriteTime -le '${escPS(String(args.modifiedBefore))}'`);
    const where = filters.length > 0 ? `| Where-Object { ${filters.join(" -and ")} }` : "";
    return ps(`Get-ChildItem '${escPS(p)}' -Recurse -File -ErrorAction SilentlyContinue ${where} | Select-Object -First ${Number(max)} FullName, @{N='SizeMB';E={[math]::Round($_.Length/1MB,2)}}, LastWriteTime | Format-Table -AutoSize`, 60_000);
  },
});

// ── Bulk Rename ──────────────────────────────────────────────

registerSkill({
  name: "files.bulk_rename",
  description: "Rename multiple files using find/replace in names. Preview mode by default.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory containing files" },
      filter: { type: "string", description: "File filter (e.g. '*.txt')" },
      find: { type: "string", description: "String to find in filenames" },
      replace: { type: "string", description: "Replacement string" },
      preview: { type: "boolean", description: "Preview only (default true)" },
    },
    required: ["path", "find", "replace"],
  },
  async execute(args) {
    const p = args.path as string;
    const filter = (args.filter as string) || "*";
    const find = args.find as string;
    const replace = args.replace as string;
    if (args.preview !== false) {
      return ps(`Get-ChildItem '${escPS(p)}' -Filter '${escPS(filter)}' | Where-Object { $_.Name -like '*${escPS(find)}*' } | ForEach-Object { $old = $_.Name; $new = $old -replace '${escPS(find)}','${escPS(replace)}'; \"$old -> $new\" }`);
    }
    return ps(`Get-ChildItem '${escPS(p)}' -Filter '${escPS(filter)}' | Where-Object { $_.Name -like '*${escPS(find)}*' } | Rename-Item -NewName { $_.Name -replace '${escPS(find)}','${escPS(replace)}' } -PassThru | ForEach-Object { 'Renamed: ' + $_.Name }`);
  },
});

// ── File Checksum ────────────────────────────────────────────

registerSkill({
  name: "files.checksum",
  description: "Calculate hash/checksum of a file (MD5, SHA1, SHA256, SHA512).",
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      algorithm: { type: "string", description: "MD5 | SHA1 | SHA256 | SHA512 (default SHA256)" },
    },
    required: ["path"],
  },
  async execute(args) {
    const algo = String(args.algorithm || "SHA256");
    if (!/^(MD5|SHA1|SHA256|SHA512)$/.test(algo)) return "Error: algorithm must be MD5, SHA1, SHA256, or SHA512.";
    return ps(`Get-FileHash '${escPS(String(args.path))}' -Algorithm ${algo} | Format-List Algorithm, Hash, Path`);
  },
});

// ── Directory Size ───────────────────────────────────────────

registerSkill({
  name: "files.dir_size",
  description: "Calculate total size of a directory and show largest subdirectories.",
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path" },
    },
    required: ["path"],
  },
  async execute(args) {
    const p = args.path as string;
    const total = ps(`(Get-ChildItem '${escPS(p)}' -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1GB | ForEach-Object { [math]::Round($_, 2).ToString() + ' GB' }`, 60_000);
    const breakdown = ps(`Get-ChildItem '${escPS(p)}' -Directory | ForEach-Object { $size = (Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum; [PSCustomObject]@{Name=$_.Name; SizeMB=[math]::Round($size/1MB,1)} } | Sort-Object SizeMB -Descending | Select-Object -First 15 | Format-Table -AutoSize`, 60_000);
    return `Total: ${total}\n\nSubdirectories:\n${breakdown}`;
  },
});

// ── File Permissions ─────────────────────────────────────────

registerSkill({
  name: "files.permissions",
  description: "View or modify file/folder permissions (ACL).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or folder path" },
      action: { type: "string", description: "view | grant | revoke" },
      user: { type: "string", description: "User/group for grant/revoke" },
      permission: { type: "string", description: "ReadAndExecute | Modify | FullControl" },
    },
    required: ["path"],
  },
  async execute(args) {
    const p = args.path as string;
    const action = (args.action as string) || "view";
    if (action === "view") {
      return ps(`Get-Acl '${escPS(p)}' | Select-Object -ExpandProperty Access | Format-Table -AutoSize IdentityReference, FileSystemRights, AccessControlType`);
    }
    const user = args.user as string;
    const perm = (args.permission as string) || "ReadAndExecute";
    if (!user) return "Error: user is required for grant/revoke";
    if (action === "grant") {
      ps(`$acl = Get-Acl '${escPS(p)}'; $rule = New-Object System.Security.AccessControl.FileSystemAccessRule('${escPS(user)}','${escPS(perm)}','Allow'); $acl.SetAccessRule($rule); Set-Acl '${escPS(p)}' $acl`);
      return `Granted ${perm} to ${user} on ${p}`;
    } else if (action === "revoke") {
      ps(`$acl = Get-Acl '${escPS(p)}'; $rules = $acl.Access | Where-Object { $_.IdentityReference -like '*${escPS(user)}*' }; foreach($r in $rules) { $acl.RemoveAccessRule($r) }; Set-Acl '${escPS(p)}' $acl`);
      return `Revoked permissions for ${user} on ${p}`;
    }
    return "Unknown action. Use: view, grant, revoke";
  },
});
