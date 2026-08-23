import { mergeGraffitiRecords, type GraffitiEvent, type GraffitiRecord } from "./compWall";

const DB_NAME = "comp-wall-cache";
const DB_VERSION = 1;

interface WallStateRecord {
  wallHash: string;
  records: GraffitiRecord[];
  updatedAt: number;
  lastScannedBlock?: string;
  lastScannedBlockHash?: string;
}

interface WallDraftRecord {
  wallHash: string;
  events: GraffitiEvent[];
  updatedAt: number;
}

export interface PendingWallPost {
  txHash: string;
  wallHash: string;
  payload: string;
  author: string;
  submittedAt: number;
}

export interface WallSnapshot {
  wallHash: string;
  eventCount: number;
  eventId: string;
  blockNumber?: string;
  blockHash?: string;
  createdAt: number;
  image: Blob;
}

let databasePromise: Promise<IDBDatabase | undefined> | undefined;

function database(): Promise<IDBDatabase | undefined> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(undefined);
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("states")) {
        db.createObjectStore("states", { keyPath: "wallHash" });
      }
      if (!db.objectStoreNames.contains("drafts")) {
        db.createObjectStore("drafts", { keyPath: "wallHash" });
      }
      if (!db.objectStoreNames.contains("pending")) {
        const store = db.createObjectStore("pending", { keyPath: "txHash" });
        store.createIndex("wallHash", "wallHash", { unique: false });
      }
      if (!db.objectStoreNames.contains("snapshots")) {
        db.createObjectStore("snapshots", { keyPath: "wallHash" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      console.warn("COMP Wall IndexedDB unavailable", request.error);
      resolve(undefined);
    };
  });
  return databasePromise;
}

async function getValue<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await database();
  if (!db) return;
  return new Promise((resolve) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => resolve(undefined);
  });
}

async function putValue(storeName: string, value: unknown): Promise<void> {
  const db = await database();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => {
      console.warn(`COMP Wall cache write failed (${storeName})`, transaction.error);
      resolve();
    };
  });
}

async function deleteValue(storeName: string, key: IDBValidKey): Promise<void> {
  const db = await database();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
  });
}

export async function readWallRecords(wallHash: string): Promise<WallStateRecord | undefined> {
  return getValue<WallStateRecord>("states", wallHash.toLowerCase());
}

export async function saveWallRecords(wallHash: string, records: GraffitiRecord[]): Promise<void> {
  const key = wallHash.toLowerCase();
  const previous = await readWallRecords(key);
  const merged = mergeGraffitiRecords(previous?.records ?? [], records);
  const lastConfirmed = [...merged].reverse().find((record) => record.status === "confirmed");
  await putValue("states", {
    wallHash: key,
    records: merged,
    updatedAt: Date.now(),
    lastScannedBlock: lastConfirmed?.blockNumber?.toString(),
    lastScannedBlockHash: lastConfirmed?.blockHash,
  } satisfies WallStateRecord);
}

export async function readWallDraft(wallHash: string): Promise<GraffitiEvent[]> {
  return (await getValue<WallDraftRecord>("drafts", wallHash.toLowerCase()))?.events ?? [];
}

export async function saveWallDraft(wallHash: string, events: GraffitiEvent[]): Promise<void> {
  const key = wallHash.toLowerCase();
  if (events.length === 0) {
    await deleteValue("drafts", key);
    return;
  }
  await putValue("drafts", {
    wallHash: key,
    events,
    updatedAt: Date.now(),
  } satisfies WallDraftRecord);
}

export async function savePendingWallPost(post: PendingWallPost): Promise<void> {
  await putValue("pending", { ...post, wallHash: post.wallHash.toLowerCase() });
}

export async function readPendingWallPosts(wallHash: string): Promise<PendingWallPost[]> {
  const db = await database();
  if (!db) return [];
  return new Promise((resolve) => {
    const transaction = db.transaction("pending", "readonly");
    const index = transaction.objectStore("pending").index("wallHash");
    const request = index.getAll(wallHash.toLowerCase());
    request.onsuccess = () => resolve((request.result as PendingWallPost[]) ?? []);
    request.onerror = () => resolve([]);
  });
}

export async function removePendingWallPost(txHash: string): Promise<void> {
  await deleteValue("pending", txHash);
}

export async function readWallSnapshot(wallHash: string): Promise<WallSnapshot | undefined> {
  return getValue<WallSnapshot>("snapshots", wallHash.toLowerCase());
}

export async function saveWallSnapshot(snapshot: WallSnapshot): Promise<void> {
  await putValue("snapshots", { ...snapshot, wallHash: snapshot.wallHash.toLowerCase() });
}

export async function clearWallSnapshot(wallHash: string): Promise<void> {
  await deleteValue("snapshots", wallHash.toLowerCase());
}
