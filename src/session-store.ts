import fs from "fs/promises";
import path from "path";

const DATA_DIR = path.resolve("data");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

export interface SessionData {
  sessionId: string;
  cwd: string;
  createdAt: string;
  lastActiveAt: string;
  lastPrompt: string;
}

// chatId → SessionData
type SessionMap = Record<string, SessionData>;

let cache: SessionMap | null = null;

// REVIEW #10: 异步写锁，防止并发读写交错
let writeLock: Promise<void> = Promise.resolve();

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function load(): Promise<SessionMap> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(SESSIONS_FILE, "utf-8");
    cache = JSON.parse(raw) as SessionMap;
  } catch {
    cache = {};
  }
  return cache;
}

function save(data: SessionMap): Promise<void> {
  const op = async () => {
    await ensureDir();
    await fs.writeFile(SESSIONS_FILE, JSON.stringify(data, null, 2), "utf-8");
  };
  writeLock = writeLock.then(op, op);
  return writeLock;
}

export async function getSession(chatId: string): Promise<SessionData | undefined> {
  const map = await load();
  return map[chatId];
}

export async function setSession(chatId: string, data: SessionData): Promise<void> {
  const map = await load();
  // REVIEW #14: 路径规范化
  data.cwd = path.resolve(data.cwd);
  map[chatId] = data;
  cache = map;
  await save(map);
}

export async function deleteSession(chatId: string): Promise<boolean> {
  const map = await load();
  if (!(chatId in map)) return false;
  delete map[chatId];
  cache = map;
  await save(map);
  return true;
}

export async function listSessions(): Promise<Record<string, SessionData>> {
  return { ...(await load()) };
}

export async function listSessionsByCwd(): Promise<Map<string, { chatId: string; session: SessionData }[]>> {
  const map = await load();
  const grouped = new Map<string, { chatId: string; session: SessionData }[]>();
  for (const [chatId, session] of Object.entries(map)) {
    const list = grouped.get(session.cwd) || [];
    list.push({ chatId, session });
    grouped.set(session.cwd, list);
  }
  // 每组按 lastActiveAt 降序
  for (const list of grouped.values()) {
    list.sort((a, b) => b.session.lastActiveAt.localeCompare(a.session.lastActiveAt));
  }
  return grouped;
}

export function getRecentDirs(): Promise<string[]> {
  return load().then((map) => {
    const dirs = new Map<string, string>();
    for (const s of Object.values(map)) {
      const existing = dirs.get(s.cwd);
      if (!existing || s.lastActiveAt > existing) {
        dirs.set(s.cwd, s.lastActiveAt);
      }
    }
    return [...dirs.entries()]
      .sort((a, b) => b[1].localeCompare(a[1]))
      .map(([dir]) => dir);
  });
}
