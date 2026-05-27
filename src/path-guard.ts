import path from "path";

const allowedDirs: string[] = (process.env.ALLOWED_DIRS || "")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean)
  .map((d) => path.resolve(d));

const shortcutDirs: string[] = (process.env.SHORTCUT_DIRS || "")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean)
  .map((d) => path.resolve(d));

export function getDefaultCwd(): string {
  const defaultCwd = process.env.DEFAULT_CWD;
  if (!defaultCwd) throw new Error("DEFAULT_CWD 未配置");
  return path.resolve(defaultCwd);
}

export function getShortcutDirs(): string[] {
  return shortcutDirs;
}

export function isAllowedDir(dir: string): boolean {
  if (allowedDirs.length === 0) return false;
  const resolved = path.resolve(dir);
  return allowedDirs.some(
    (allowed) => resolved === allowed || resolved.startsWith(allowed + path.sep)
  );
}

export function validateCwd(dir: string): string {
  const resolved = path.resolve(dir);
  if (!isAllowedDir(resolved)) {
    throw new Error(`目录不在白名单中: ${dir}`);
  }
  return resolved;
}
