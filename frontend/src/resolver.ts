import { ccc } from "@ckb-ccc/shell";
import { client, HISTORY_LIMIT, MESSAGE_FEE_RATE, MIN_CELL_CAPACITY, PENDING_POLL_INTERVAL_MS } from "./rpc";
import { compLockTemplate, loadDeployment, parseCompArgs } from "./config";
import { channelKind, channelName } from "./channelNames";
import {
  readCachedMessages,
  saveCachedChannels,
  saveCachedMessages,
} from "./scanCache";
import { parseCompMessage, sleep } from "./utils";
import type { Channel, ChannelState, CompCell, Message } from "./types";

interface PendingRecord {
  txHash: string;
  channelHash: string;
  submittedAt: number;
}

export interface ResolvedMessageTransaction {
  channelHash: string;
  channelName: string;
  transactionStatus: string;
  message: Message;
}

const pendingRecords = new Map<string, PendingRecord>();

async function blockMetadata(
  blockNumber: bigint,
  txHash: string,
): Promise<{ timestamp?: bigint; transactionIndex?: number }> {
  try {
    const block = await client.getBlockByNumber(blockNumber);
    const index = block?.transactions.findIndex(
      (transaction) => transaction.hash().toLowerCase() === txHash.toLowerCase(),
    );
    return {
      timestamp: block?.header.timestamp,
      transactionIndex: index !== undefined && index >= 0 ? index : undefined,
    };
  } catch {
    try {
      return { timestamp: (await client.getHeaderByNumber(blockNumber))?.timestamp };
    } catch {
      return {};
    }
  }
}

async function cellToCompCell(cell: ccc.Cell): Promise<CompCell | undefined> {
  try {
    const { channelHash, maxFee } = parseCompArgs(cell.cellOutput.lock.args);
    return {
      outPoint: cell.outPoint,
      cellOutput: cell.cellOutput,
      outputData: cell.outputData,
      channelHash,
      maxFee,
    };
  } catch {
    return undefined;
  }
}

export async function discoverChannels(): Promise<Channel[]> {
  const cfg = await loadDeployment();
  const template = compLockTemplate(cfg);
  const cells: ccc.Cell[] = [];

  for await (const cell of client.findCells(
    { script: template, scriptType: "lock", scriptSearchMode: "prefix" },
    "desc",
    100,
  )) {
    cells.push(cell);
  }

  const byHash = new Map<string, CompCell[]>();
  for (const cell of cells) {
    const comp = await cellToCompCell(cell);
    if (!comp) continue;
    const list = byHash.get(comp.channelHash) ?? [];
    list.push(comp);
    byHash.set(comp.channelHash, list);
  }

  const channels: Channel[] = [];
  for (const [hash, cells] of byHash.entries()) {
    const maxFee = cells[0]?.maxFee ?? 0n;
    const totalCapacity = cells.reduce((sum, c) => sum + c.cellOutput.capacity, 0n);
    channels.push({
      hash,
      name: channelName(hash, cells.map((cell) => cell.outputData)),
      kind: channelKind(hash, cells.map((cell) => cell.outputData)),
      maxFee,
      cells,
      totalCapacity,
    });
  }

  const sorted = channels.sort((a, b) => (a.name < b.name ? -1 : 1));
  saveCachedChannels(sorted);
  return sorted;
}

export async function findChannel(channelHash: string): Promise<Channel | undefined> {
  const channels = await discoverChannels();
  return channels.find((c) => c.hash.toLowerCase() === channelHash.toLowerCase());
}

function scriptsEqual(left: ccc.Script, right: ccc.Script): boolean {
  return left.codeHash.toLowerCase() === right.codeHash.toLowerCase()
    && left.hashType === right.hashType
    && left.args.toLowerCase() === right.args.toLowerCase();
}

export async function resolveMessageTransaction(
  channelHash: string,
  txHash: string,
): Promise<ResolvedMessageTransaction> {
  const [cfg, response] = await Promise.all([
    loadDeployment(),
    client.getTransaction(txHash),
  ]);
  if (!response) throw new Error(`transaction ${txHash} not found`);

  const tx = response.transaction;
  let inputIndex = -1;
  let inputCell: ccc.Cell | undefined;
  for (let index = 0; index < tx.inputs.length; index++) {
    const cell = await client.getCell(tx.inputs[index].previousOutput);
    if (!cell) continue;
    const lock = cell.cellOutput.lock;
    if (
      lock.codeHash.toLowerCase() !== cfg.codeHash.toLowerCase()
      || lock.hashType !== cfg.hashType
    ) continue;
    try {
      if (parseCompArgs(lock.args).channelHash.toLowerCase() === channelHash.toLowerCase()) {
        inputIndex = index;
        inputCell = cell;
        break;
      }
    } catch {
      // Not a COMP lock input.
    }
  }

  if (inputIndex < 0 || !inputCell) {
    throw new Error("transaction does not consume a COMP Cell from this channel");
  }

  const compMessage = parseCompMessage(tx, inputIndex);
  if (!compMessage) throw new Error("transaction does not contain a valid COMP text message");

  const outputIndex = tx.outputs.findIndex((output) =>
    scriptsEqual(output.lock, inputCell!.cellOutput.lock)
  );
  const inputCapacity = inputCell.cellOutput.capacity;
  const outputCapacity = outputIndex < 0 ? undefined : tx.outputs[outputIndex].capacity;
  const blockNumber = response.blockNumber;
  const metadata = blockNumber === undefined
    ? {}
    : await blockMetadata(blockNumber, txHash);

  const message: Message = {
    txHash,
    status: response.status === "committed" ? "confirmed" : "pending",
    blockNumber,
    blockHash: response.blockHash,
    timestamp: metadata.timestamp,
    transactionIndex: metadata.transactionIndex,
    compInputIndex: inputIndex,
    author: compMessage.public_key ?? compMessage.address ?? "Anonymous",
    payload: String(compMessage.extensions.payload),
    inputCapacity,
    outputCapacity,
    capacityDelta: outputCapacity === undefined ? undefined : outputCapacity - inputCapacity,
  };
  if (message.status === "confirmed") saveCachedMessages(channelHash, [message]);

  const outputData = outputIndex < 0 ? undefined : tx.outputsData[outputIndex];
  const channelData: string[] = [inputCell.outputData];
  if (outputData !== undefined) channelData.push(outputData);
  return {
    channelHash,
    channelName: channelName(channelHash, channelData),
    transactionStatus: response.status,
    message,
  };
}

function estimateMessageFee(): bigint {
  // A COMP message tx is small (~300-400 bytes). Estimate generously.
  return MESSAGE_FEE_RATE * 400n;
}

export function availableCells(cells: CompCell[]): CompCell[] {
  const fee = estimateMessageFee();
  return cells.filter((c) => c.cellOutput.capacity > fee + MIN_CELL_CAPACITY);
}

export function pickAvailableCell(cells: CompCell[]): CompCell | undefined {
  const avail = availableCells(cells);
  if (avail.length === 0) return undefined;
  // Prefer larger cells to reduce the chance of running out of capacity.
  avail.sort((a, b) => Number(b.cellOutput.capacity - a.cellOutput.capacity));
  return avail[0];
}

async function loadConfirmedMessages(
  channel: Channel,
  limit: number,
): Promise<{ messages: Message[]; hasMore: boolean }> {
  // Collect unique lock scripts across all cells in this channel.
  const seenLocks = new Set<string>();
  const locks: ccc.Script[] = [];
  for (const cell of channel.cells) {
    const key = `${cell.cellOutput.lock.codeHash}:${cell.cellOutput.lock.hashType}:${cell.cellOutput.lock.args}`;
    if (seenLocks.has(key)) continue;
    seenLocks.add(key);
    locks.push(cell.cellOutput.lock);
  }

  if (locks.length === 0) return { messages: [], hasMore: false };

  const recordMap = new Map<string, {
    txHash: string;
    blockNumber: bigint;
    cells: { isInput: boolean; cellIndex: bigint }[];
  }>();

  // Fetch one extra record to determine if there are more, up to the UI's
  // documented history ceiling.
  const requestedLimit = Math.min(limit, HISTORY_LIMIT);
  const fetchLimit = Math.min(requestedLimit + 1, HISTORY_LIMIT);

  for (const lock of locks) {
    for await (const record of client.findTransactionsByLock(lock, null, true, "desc", fetchLimit)) {
      const existing = recordMap.get(record.txHash);
      if (existing) {
        // Merge cell references.
        for (const cell of record.cells) {
          if (!existing.cells.some((c) => c.isInput === cell.isInput && c.cellIndex === cell.cellIndex)) {
            existing.cells.push(cell);
          }
        }
      } else {
        recordMap.set(record.txHash, record);
      }
      if (recordMap.size >= fetchLimit) break;
    }
    if (recordMap.size >= fetchLimit) break;
  }

  const hasMore = recordMap.size > requestedLimit;

  // Sort by block number descending: newest first.
  const records = Array.from(recordMap.values())
    .sort((a, b) => (a.blockNumber > b.blockNumber ? -1 : 1))
    .slice(0, requestedLimit);

  const cached = readCachedMessages(channel.hash);
  const cachedByTxHash = new Map(
    (cached?.value ?? []).map((message) => [message.txHash, message]),
  );
  const messages: Message[] = [];
  for (const record of records) {
    const cachedMessage = cachedByTxHash.get(record.txHash);
    if (cachedMessage) {
      messages.push(cachedMessage);
      continue;
    }
    try {
      const response = await client.getTransaction(record.txHash);
      if (!response) continue;
      const tx = response.transaction;
      const inputRecord = record.cells.find((c) => c.isInput);
      const outputRecord = record.cells.find((c) => !c.isInput);
      const inputIndex = inputRecord ? Number(inputRecord.cellIndex) : undefined;
      const outputIndex = outputRecord ? Number(outputRecord.cellIndex) : undefined;

      let inputCapacity: bigint | undefined;
      if (inputIndex !== undefined) {
        const inputCell = await client.getCell(tx.inputs[inputIndex].previousOutput);
        inputCapacity = inputCell?.cellOutput.capacity;
      }
      const outputCapacity = outputIndex === undefined
        ? undefined
        : tx.outputs[outputIndex]?.capacity;

      const compMsg = parseCompMessage(tx, inputIndex);
      if (!compMsg) continue;

      const metadata = await blockMetadata(record.blockNumber, record.txHash);

      messages.push({
        txHash: record.txHash,
        status: response.status === "committed" ? "confirmed" : "pending",
        blockNumber: response.blockNumber ?? record.blockNumber,
        blockHash: response.blockHash,
        timestamp: metadata.timestamp,
        transactionIndex: metadata.transactionIndex,
        compInputIndex: inputIndex,
        author: compMsg.public_key ?? compMsg.address ?? "Anonymous",
        payload: String(compMsg.extensions.payload),
        capacityDelta:
          inputCapacity !== undefined && outputCapacity !== undefined
            ? outputCapacity - inputCapacity
            : undefined,
        inputCapacity,
        outputCapacity,
      });
    } catch (e) {
      console.error("loadConfirmedMessages", record.txHash, e);
    }
  }

  saveCachedMessages(channel.hash, messages);
  return { messages, hasMore }; // newest first
}

export async function loadPendingMessages(channelHash: string): Promise<Message[]> {
  const messages: Message[] = [];
  const now = Date.now();

  for (const [txHash, record] of pendingRecords.entries()) {
    if (record.channelHash.toLowerCase() !== channelHash.toLowerCase()) continue;
    if (now - record.submittedAt > 10 * 60 * 1000) {
      // Drop records older than 10 minutes.
      pendingRecords.delete(txHash);
      continue;
    }

    try {
      const response = await client.getTransaction(txHash);
      if (!response) continue;

      // If already committed, it will appear in confirmed messages on next refresh.
      if (response.status === "committed" || response.status === "rejected") {
        pendingRecords.delete(txHash);
        continue;
      }

      const tx = response.transaction;
      let inputIndex = tx.inputs.findIndex((input) => {
        const args = input.cellOutput?.lock.args;
        if (!args) return false;
        try {
          return parseCompArgs(args).channelHash.toLowerCase() === channelHash.toLowerCase();
        } catch {
          return false;
        }
      });

      if (inputIndex < 0) {
        // RPC did not include input cell outputs; fetch them.
        for (let i = 0; i < tx.inputs.length; i++) {
          try {
            const inputCell = await client.getCell(tx.inputs[i].previousOutput);
            const args = inputCell?.cellOutput.lock.args;
            if (args && parseCompArgs(args).channelHash.toLowerCase() === channelHash.toLowerCase()) {
              inputIndex = i;
              break;
            }
          } catch {
            // ignore
          }
        }
      }

      const compMsg = parseCompMessage(tx, inputIndex >= 0 ? inputIndex : undefined);
      if (!compMsg) continue;

      messages.push({
        txHash,
        status: "pending",
        author: compMsg.public_key ?? compMsg.address ?? "Anonymous",
        payload: String(compMsg.extensions.payload),
        compInputIndex: inputIndex >= 0 ? inputIndex : 0,
      });
    } catch (e) {
      console.error("loadPendingMessages", txHash, e);
    }
  }

  return messages;
}

export async function resolveChannelState(
  channelHash: string,
  confirmedLimit: number = 20,
): Promise<ChannelState> {
  const channel = await findChannel(channelHash);
  if (!channel) {
    throw new Error(`channel ${channelHash} not found`);
  }

  const [confirmedResult, pending] = await Promise.all([
    loadConfirmedMessages(channel, confirmedLimit),
    loadPendingMessages(channelHash),
  ]);

  return {
    channel,
    liveCells: channel.cells,
    availableCells: availableCells(channel.cells),
    confirmed: confirmedResult.messages,
    pending,
    confirmedLimit,
    hasMoreConfirmed: confirmedResult.hasMore,
  };
}

export function trackPendingTx(txHash: string, channelHash: string, submittedAt = Date.now()) {
  pendingRecords.set(txHash, {
    txHash,
    channelHash,
    submittedAt,
  });
}

export async function waitForCommitted(txHash: string, timeoutMs = 120000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await client.getTransaction(txHash);
      if (response?.status === "committed") return true;
      if (response?.status === "rejected") return false;
    } catch {
      // ignore
    }
    await sleep(Math.min(PENDING_POLL_INTERVAL_MS, deadline - Date.now()));
  }
  return false;
}

export function clearPendingTracking() {
  pendingRecords.clear();
}
