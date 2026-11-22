import type { ScribeDraft } from "./draftWorkspace";

const DB_NAME = "kibitz-scribe-drafts";
const DB_VERSION = 1;
const STORE_NAME = "drafts";

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

export async function saveLocalDraft(draft: ScribeDraft): Promise<void> {
  const stamped: ScribeDraft = {
    ...draft,
    updatedAt: new Date().toISOString(),
  };

  if (!hasIndexedDb()) {
    memoryFallback.set(stamped.id, stamped);
    return;
  }

  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(stamped);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Failed to save local draft."));
  });
  db.close();
}

export async function loadLocalDraft(id: string): Promise<ScribeDraft | null> {
  if (!hasIndexedDb()) {
    return memoryFallback.get(id) ?? null;
  }

  const db = await openDb();
  const result = await new Promise<ScribeDraft | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve((req.result as ScribeDraft | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error("Failed to load local draft."));
  });
  db.close();
  return result;
}

export async function listLocalDrafts(): Promise<DraftSummary[]> {
  if (!hasIndexedDb()) {
    return [...memoryFallback.values()]
      .map((d) => ({
        id: d.id,
        title: d.manifest.title || "Untitled PGNA Study",
        updatedAt: d.updatedAt,
        clipCount: Object.keys(d.manifest.clips).length,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  const db = await openDb();
  const all = await new Promise<ScribeDraft[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve((req.result as ScribeDraft[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error("Failed to list local drafts."));
  });
  db.close();

  return all
    .map((d) => ({
      id: d.id,
      title: d.manifest.title || "Untitled PGNA Study",
      updatedAt: d.updatedAt,
      clipCount: Object.keys(d.manifest.clips).length,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteLocalDraft(id: string): Promise<void> {
  if (!hasIndexedDb()) {
    memoryFallback.delete(id);
    return;
  }

  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Failed to delete local draft."));
  });
  db.close();
}
