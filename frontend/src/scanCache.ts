import { ccc } from "@ckb-ccc/shell";
import type { Channel, CompCell, Message } from "./types";

const STORAGE_KEY = "comp-shared-lock.scan-cache.v1";
const CACHE_VERSION = 1;
const MAX_MESSAGES_PER_CHANNEL = 200;

interface StoredScript {
  codeHash: string;
  hashType: ccc.HashType;
  args: string;
}

interface StoredCell {
  outPoint: { txHash: string; index: string };
  cellOutput: {
    capacity: string;
    lock: StoredScript;
    type?: StoredScript;
  };
  outputData: string;
  channelHash: string;
  maxFee: string;
}

interface StoredChannel {
  hash: string;
  name: string;
  maxFee: string;
  cells: StoredCell[];
  totalCapacity: string;
}

interface StoredMessage {
  txHash: string;
  blockNumber?: string;
  blockHash?: string;
  timestamp?: string;
  transactionIndex?: number;
  compInputIndex?: number;
  author: string;
  payload: string;
  capacityDelta?: string;
  inputCapacity?: string;
  outputCapacity?: string;
}

interface StoredSnapshot<T> {
  updatedAt: number;
  value: T;
}

interface ScanStore {
  version: number;
  channels?: StoredSnapshot<StoredChannel[]>;
  messages: Record<string, StoredSnapshot<StoredMessage[]>>;
}

export interface CacheSnapshot<T> {
  updatedAt: number;
  value: T;
}

function emptyStore(): ScanStore {
  return { version: CACHE_VERSION, messages: {} };
}

function loadStore(): ScanStore {
  if (typeof localStorage === "undefined") return emptyStore();
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<ScanStore> | null;
    if (parsed?.version !== CACHE_VERSION || typeof parsed.messages !== "object") {
      return emptyStore();
    }
    return {
      version: CACHE_VERSION,
      channels: parsed.channels,
      messages: parsed.messages ?? {},
    };
  } catch {
    return emptyStore();
  }
}

function saveStore(store: ScanStore): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (error) {
    // A full or disabled storage area must not prevent live chain reads.
    console.warn("scan cache write skipped", error);
  }
}

function storeScript(script: ccc.Script): StoredScript {
  return {
    codeHash: script.codeHash,
    hashType: script.hashType,
    args: script.args,
  };
}

function storeCell(cell: CompCell): StoredCell {
  return {
    outPoint: {
      txHash: cell.outPoint.txHash,
      index: cell.outPoint.index.toString(),
    },
    cellOutput: {
      capacity: cell.cellOutput.capacity.toString(),
      lock: storeScript(cell.cellOutput.lock),
      type: cell.cellOutput.type ? storeScript(cell.cellOutput.type) : undefined,
    },
    outputData: cell.outputData,
    channelHash: cell.channelHash,
    maxFee: cell.maxFee.toString(),
  };
}

function restoreCell(stored: StoredCell): CompCell {
  const cell = ccc.Cell.from({
    outPoint: {
      txHash: stored.outPoint.txHash,
      index: BigInt(stored.outPoint.index),
    },
    cellOutput: {
      capacity: BigInt(stored.cellOutput.capacity),
      lock: stored.cellOutput.lock,
      type: stored.cellOutput.type,
    },
    outputData: stored.outputData,
  });
  return {
    outPoint: cell.outPoint,
    cellOutput: cell.cellOutput,
    outputData: cell.outputData,
    channelHash: stored.channelHash,
    maxFee: BigInt(stored.maxFee),
  };
}

function storeChannel(channel: Channel): StoredChannel {
  return {
    hash: channel.hash,
    name: channel.name,
    maxFee: channel.maxFee.toString(),
    cells: channel.cells.map(storeCell),
    totalCapacity: channel.totalCapacity.toString(),
  };
}

function restoreChannel(stored: StoredChannel): Channel {
  return {
    hash: stored.hash,
    name: stored.name,
    maxFee: BigInt(stored.maxFee),
    cells: stored.cells.map(restoreCell),
    totalCapacity: BigInt(stored.totalCapacity),
  };
}

function storeMessage(message: Message): StoredMessage {
  return {
    txHash: message.txHash,
    blockNumber: message.blockNumber?.toString(),
    blockHash: message.blockHash,
    timestamp: message.timestamp?.toString(),
    transactionIndex: message.transactionIndex,
    compInputIndex: message.compInputIndex,
    author: message.author,
    payload: message.payload,
    capacityDelta: message.capacityDelta?.toString(),
    inputCapacity: message.inputCapacity?.toString(),
    outputCapacity: message.outputCapacity?.toString(),
  };
}

function restoreMessage(stored: StoredMessage): Message {
  return {
    txHash: stored.txHash,
    status: "confirmed",
    blockNumber: stored.blockNumber === undefined ? undefined : BigInt(stored.blockNumber),
    blockHash: stored.blockHash,
    timestamp: stored.timestamp === undefined ? undefined : BigInt(stored.timestamp),
    transactionIndex: stored.transactionIndex,
    compInputIndex: stored.compInputIndex,
    author: stored.author,
    payload: stored.payload,
    capacityDelta: stored.capacityDelta === undefined ? undefined : BigInt(stored.capacityDelta),
    inputCapacity: stored.inputCapacity === undefined ? undefined : BigInt(stored.inputCapacity),
    outputCapacity: stored.outputCapacity === undefined ? undefined : BigInt(stored.outputCapacity),
  };
}

function newestFirst(a: Message, b: Message): number {
  const aBlock = a.blockNumber ?? -1n;
  const bBlock = b.blockNumber ?? -1n;
  if (aBlock !== bBlock) return aBlock > bBlock ? -1 : 1;
  const aTime = a.timestamp ?? -1n;
  const bTime = b.timestamp ?? -1n;
  return aTime === bTime ? 0 : aTime > bTime ? -1 : 1;
}

export function readCachedChannels(): CacheSnapshot<Channel[]> | undefined {
  const snapshot = loadStore().channels;
  if (!snapshot) return undefined;
  try {
    return {
      updatedAt: snapshot.updatedAt,
      value: snapshot.value.map(restoreChannel),
    };
  } catch {
    return undefined;
  }
}

export function saveCachedChannels(channels: Channel[]): void {
  const store = loadStore();
  store.channels = {
    updatedAt: Date.now(),
    value: channels.map(storeChannel),
  };
  saveStore(store);
}

export function readCachedMessages(
  channelHash: string,
  limit = MAX_MESSAGES_PER_CHANNEL,
): CacheSnapshot<Message[]> | undefined {
  const snapshot = loadStore().messages[channelHash.toLowerCase()];
  if (!snapshot) return undefined;
  try {
    return {
      updatedAt: snapshot.updatedAt,
      value: snapshot.value.map(restoreMessage).sort(newestFirst).slice(0, limit),
    };
  } catch {
    return undefined;
  }
}

export function saveCachedMessages(channelHash: string, messages: Message[]): void {
  const store = loadStore();
  const key = channelHash.toLowerCase();
  const previous = readCachedMessages(channelHash)?.value ?? [];
  const merged = new Map(previous.map((message) => [message.txHash, message]));
  for (const message of messages) {
    if (message.status === "confirmed") merged.set(message.txHash, message);
  }
  store.messages[key] = {
    updatedAt: Date.now(),
    value: Array.from(merged.values())
      .sort(newestFirst)
      .slice(0, MAX_MESSAGES_PER_CHANNEL)
      .map(storeMessage),
  };
  saveStore(store);
}
