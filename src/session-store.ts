import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

const DATA_DIR = path.resolve("data");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

export interface SessionData {
  sessionId: string;
  cwd: string;
  createdAt: string;
  lastActiveAt: string;
  lastPrompt: string;
}

export interface SessionEntry extends SessionData {
  id: string;
}

interface ChatStore {
  activeId: string;
  sessions: SessionEntry[];
}

type SessionMap = Record<string, ChatStore>;

let cache: SessionMap | null = null;
let writeLock: Promise<void> = Promise.resolve();

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function migrate(raw: Record<string, unknown>): SessionMap {
  const result: SessionMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    if ("sessions" in v && Array.isArray(v.sessions)) {
      result[key] = value as unknown as ChatStore;
    } else if ("sessionId" in v) {
      const id = randomUUID();
      result[key] = {
        activeId: id,
        sessions: [{ id, ...(v as unknown as SessionData) }],
      };
    }
  }
  return result;
}

async function load(): Promise<SessionMap> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(SESSIONS_FILE, "utf-8");
    cache = migrate(JSON.parse(raw));
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

function getActive(store: ChatStore): SessionEntry | undefined {
  return store.sessions.find((s) => s.id === store.activeId);
}

export async function getSession(chatId: string): Promise<SessionData | undefined> {
  const map = await load();
  const store = map[chatId];
  if (!store) return undefined;
  const entry = getActive(store);
  if (!entry) return undefined;
  const { id: _, ...data } = entry;
  return data;
}

export async function setSession(chatId: string, data: SessionData): Promise<void> {
  const map = await load();
  const store = map[chatId];
  if (store) {
    const idx = store.sessions.findIndex((s) => s.id === store.activeId);
    if (idx >= 0) {
      store.sessions[idx] = { ...data, id: store.activeId, cwd: path.resolve(data.cwd) };
    } else {
      const id = randomUUID();
      store.sessions.push({ ...data, id, cwd: path.resolve(data.cwd) });
      store.activeId = id;
    }
  } else {
    const id = randomUUID();
    map[chatId] = { activeId: id, sessions: [{ ...data, id, cwd: path.resolve(data.cwd) }] };
  }
  cache = map;
  await save(map);
}

export async function createSession(chatId: string, data: SessionData): Promise<void> {
  const map = await load();
  const id = randomUUID();
  const entry: SessionEntry = { ...data, id, cwd: path.resolve(data.cwd) };
  if (map[chatId]) {
    map[chatId].sessions.push(entry);
    map[chatId].activeId = id;
  } else {
    map[chatId] = { activeId: id, sessions: [entry] };
  }
  cache = map;
  await save(map);
}

export async function deleteSession(chatId: string): Promise<boolean> {
  const map = await load();
  const store = map[chatId];
  if (!store) return false;
  store.sessions = store.sessions.filter((s) => s.id !== store.activeId);
  if (store.sessions.length === 0) {
    delete map[chatId];
  } else {
    store.activeId = store.sessions[store.sessions.length - 1].id;
  }
  cache = map;
  await save(map);
  return true;
}

export async function listSessionsForChat(chatId: string): Promise<SessionEntry[]> {
  const map = await load();
  const store = map[chatId];
  if (!store) return [];
  return [...store.sessions].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
}

export async function switchSession(chatId: string, entryId: string): Promise<boolean> {
  const map = await load();
  const store = map[chatId];
  if (!store) return false;
  const entry = store.sessions.find((s) => s.id === entryId);
  if (!entry) return false;
  store.activeId = entryId;
  entry.lastActiveAt = new Date().toISOString();
  cache = map;
  await save(map);
  return true;
}

export async function listSessionsByCwd(): Promise<Map<string, { chatId: string; session: SessionData }[]>> {
  const map = await load();
  const grouped = new Map<string, { chatId: string; session: SessionData }[]>();
  for (const [chatId, store] of Object.entries(map)) {
    for (const entry of store.sessions) {
      const { id: _, ...session } = entry;
      const list = grouped.get(session.cwd) || [];
      list.push({ chatId, session });
      grouped.set(session.cwd, list);
    }
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => b.session.lastActiveAt.localeCompare(a.session.lastActiveAt));
  }
  return grouped;
}

export function getRecentDirs(): Promise<string[]> {
  return load().then((map) => {
    const dirs = new Map<string, string>();
    for (const store of Object.values(map)) {
      for (const s of store.sessions) {
        const existing = dirs.get(s.cwd);
        if (!existing || s.lastActiveAt > existing) {
          dirs.set(s.cwd, s.lastActiveAt);
        }
      }
    }
    return [...dirs.entries()]
      .sort((a, b) => b[1].localeCompare(a[1]))
      .map(([dir]) => dir);
  });
}
