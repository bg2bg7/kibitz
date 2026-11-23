import { normalizeScribeDraft, type ScribeDraft } from "./draftWorkspace";

const DB_NAME = "kibitz-scribe-drafts";
const DB_VERSION = 1;
const STORE_NAME = "drafts";

export type DraftPersistenceMode = "indexeddb" | "memory";

export interface SaveLocalDraftResult {
  mode: DraftPersistenceMode;
  updatedAt: string;
}

export interface DraftSummary {
  id: string;
  title: string;
  updatedAt: string;
  clipCount: number;
}

const memoryFallback = new Map<string, ScribeDraft>();

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

export function getDraftStorageMode(): DraftPersistenceMode {
  return hasIndexedDb() ? "indexeddb" : "memory";
}

export function clearMemoryDraftFallbackForTests(): void {
  memoryFallback.clear();
}

function summarizeDrafts(records: ReadonlyArray<unknown>): DraftSummary[] {
  const summaries: DraftSummary[] = [];
  for (const raw of records) {
    const normalized = normalizeScribeDraft(raw);
    if (!normalized) {
      continue;
    }
    summaries.push({
      id: normalized.id,
      title: normalized.manifest.title || "Untitled PGNA Study",
      updatedAt: normalized.updatedAt,
      clipCount: Object.keys(normalized.manifest.clips).length,
    });
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB."));
  });
}

export async function saveLocalDraft(draft: ScribeDraft): Promise<SaveLocalDraftResult> {
  const updatedAt = new Date().toISOString();
  const normalized = normalizeScribeDraft({
    ...draft,
    updatedAt,
  });
  if (!normalized) {
    throw new Error("Cannot save malformed draft.");
  }

  const stamped: ScribeDraft = {
    ...normalized,
    updatedAt,
  };

  if (!hasIndexedDb()) {
    memoryFallback.set(stamped.id, stamped);
    return { mode: "memory", updatedAt };
  }

  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(stamped);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to save local draft."));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    });
    return { mode: "indexeddb", updatedAt };
  } finally {
    db.close();
  }
}

export async function loadLocalDraft(id: string): Promise<ScribeDraft | null> {
  if (!hasIndexedDb()) {
    const stored = memoryFallback.get(id);
    return stored ? normalizeScribeDraft(stored) : null;
  }

  const db = await openDb();
  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error ?? new Error("Failed to load local draft."));
      tx.onerror = () => reject(tx.error ?? new Error("Failed to load local draft."));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    });
    return raw ? normalizeScribeDraft(raw) : null;
  } finally {
    db.close();
  }
}

export async function listLocalDrafts(): Promise<DraftSummary[]> {
  if (!hasIndexedDb()) {
    return summarizeDrafts([...memoryFallback.values()]);
  }

  const db = await openDb();
  let all: unknown[];
  try {
    all = await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => reject(req.error ?? new Error("Failed to list local drafts."));
      tx.onerror = () => reject(tx.error ?? new Error("Failed to list local drafts."));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    });
  } finally {
    db.close();
  }

  return summarizeDrafts(all);
}

export async function deleteLocalDraft(id: string): Promise<void> {
  if (!hasIndexedDb()) {
    memoryFallback.delete(id);
    return;
  }

  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to delete local draft."));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    });
  } finally {
    db.close();
  }
}
