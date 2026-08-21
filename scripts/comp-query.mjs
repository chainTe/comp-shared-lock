#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { ccc } from "@ckb-ccc/shell";

const ROOT = new URL("../", import.meta.url);
const DEPLOYMENT = JSON.parse(
  readFileSync(new URL("deployment.json", ROOT), "utf8"),
);
const RPC_URL = process.env.COMP_CKB_RPC ?? DEPLOYMENT.rpcUrl ?? "https://testnet.ckb.dev/";
const EXPLORER_TX_URL = "https://pudge.explorer.nervos.org/transaction/";
const MESSAGE_FEE_RATE = 3600n;
const MIN_CELL_CAPACITY = 61n * 10n ** 8n;
const KNOWN_CHANNELS = new Map([
  ["0x3bf471b16283375362945f60972e6dd4a998db34b53623457dcaa800b6a42726", "General"],
  ["0x263b341b07e11e287668ba408ff67842bd370a179107d33d149e86ea76d59ec8", "Gas Pool"],
]);

const client = new ccc.ClientPublicTestnet({ url: RPC_URL });

function emit(value, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exitCode = exitCode;
}

function fail(message) {
  emit({ status: "error", message }, 2);
}

function hashValue(value, label) {
  if (!/^0x[0-9a-f]{64}$/i.test(value ?? "")) {
    throw new Error(`${label} must be a 0x-prefixed 32-byte hash`);
  }
  return value.toLowerCase();
}

function parseArgs(args) {
  const bytes = ccc.bytesFrom(args);
  if (bytes.length !== 40) return undefined;
  const channelHash = ccc.hexFrom(bytes.slice(0, 32));
  const view = new DataView(bytes.buffer, bytes.byteOffset + 32, 8);
  return { channelHash, maxFee: view.getBigUint64(0, true) };
}

function channelSlug(name) {
  const displayName = name.normalize("NFKC").trim();
  const slug = displayName
    .toLocaleLowerCase("en-US")
    .replace(/[’']/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug;
}

function metadataName(outputData, expectedHash) {
  if (!outputData || outputData === "0x") return undefined;
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(ccc.bytesFrom(outputData)),
    );
    if (
      value?.protocol !== "comp" ||
      value?.version !== 1 ||
      value?.type !== "channel" ||
      typeof value?.name !== "string" ||
      typeof value?.slug !== "string" ||
      channelSlug(value.name) !== value.slug
    ) return undefined;
    const derived = ccc.hexFrom(
      ccc.hashCkb(ccc.bytesFrom(`comp-channel-${value.slug}`, "utf8")),
    );
    return derived.toLowerCase() === expectedHash.toLowerCase()
      ? value.name.normalize("NFKC").trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function parseMessage(tx, inputIndex) {
  if (inputIndex === undefined) return undefined;
  try {
    const lock = tx.getWitnessArgsAtUnsafe(inputIndex)?.lock;
    if (!lock) return undefined;
    const value = JSON.parse(
      new TextDecoder().decode(ccc.bytesFrom(lock)),
    );
    const ext = value?.extensions;
    if (
      !ext ||
      ext.protocol !== "comp" ||
      (ext.version !== 1 && ext.version !== 2) ||
      ext.type !== "text" ||
      typeof ext.payload !== "string"
    ) return undefined;
    return {
      author: value.public_key ?? value.address ?? "Anonymous",
      payload: ext.payload,
    };
  } catch {
    return undefined;
  }
}

function outPointJson(outPoint) {
  return {
    txHash: outPoint.txHash,
    index: `0x${BigInt(outPoint.index).toString(16)}`,
  };
}

function signedCapacity(value) {
  if (value === 0n) return "0";
  return `${value < 0n ? "-" : "+"}${ccc.fixedPointToString(value < 0n ? -value : value)}`;
}

function payloadJson(payload, full) {
  const characters = Array.from(payload);
  const bytes = new TextEncoder().encode(payload).length;
  if (full) return { payload, payloadBytes: bytes, payloadTruncated: false };
  const truncated = characters.length > 240;
  return {
    payloadPreview: `${characters.slice(0, 240).join("")}${truncated ? "…" : ""}`,
    payloadBytes: bytes,
    payloadTruncated: truncated,
  };
}

async function discoverChannels() {
  const template = ccc.Script.from({
    codeHash: DEPLOYMENT.codeHash,
    hashType: DEPLOYMENT.hashType,
    args: "0x",
  });
  const groups = new Map();

  for await (const cell of client.findCells(
    { script: template, scriptType: "lock", scriptSearchMode: "prefix" },
    "desc",
    100,
  )) {
    const parsed = parseArgs(cell.cellOutput.lock.args);
    if (!parsed) continue;
    const key = parsed.channelHash.toLowerCase();
    const group = groups.get(key) ?? { hash: key, cells: [] };
    group.cells.push({ cell, maxFee: parsed.maxFee });
    groups.set(key, group);
  }

  return Array.from(groups.values())
    .map((group) => {
      const totalCapacity = group.cells.reduce(
        (sum, entry) => sum + entry.cell.cellOutput.capacity,
        0n,
      );
      const names = group.cells
        .map((entry) => metadataName(entry.cell.outputData, group.hash))
        .filter(Boolean);
      const maxFees = [...new Set(group.cells.map((entry) => entry.maxFee.toString()))];
      const estimatedFee = MESSAGE_FEE_RATE * 400n;
      return {
        name: KNOWN_CHANNELS.get(group.hash) ?? names[0] ?? `Channel ${group.hash.slice(0, 10)}…${group.hash.slice(-4)}`,
        channelHash: group.hash,
        totalCapacityShannon: totalCapacity.toString(),
        totalCapacityCkb: ccc.fixedPointToString(totalCapacity),
        cellCount: group.cells.length,
        availableCellCount: group.cells.filter(
          (entry) => entry.cell.cellOutput.capacity > estimatedFee + MIN_CELL_CAPACITY,
        ).length,
        maxFeeShannon: maxFees[0],
        maxFeeCkb: ccc.fixedPointToString(BigInt(maxFees[0])),
        maxFeesConsistent: maxFees.length === 1,
        cells: group.cells,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function messageHistory(channel, limit, full) {
  const locks = new Map();
  for (const entry of channel.cells) {
    const lock = entry.cell.cellOutput.lock;
    const key = `${lock.codeHash}:${lock.hashType}:${lock.args}`;
    locks.set(key, lock);
  }

  const records = new Map();
  for (const lock of locks.values()) {
    for await (const record of client.findTransactionsByLock(
      lock,
      null,
      true,
      "desc",
      Math.min(limit + 1, 100),
    )) {
      const existing = records.get(record.txHash);
      if (existing) {
        for (const cell of record.cells) {
          if (!existing.cells.some(
            (candidate) =>
              candidate.isInput === cell.isInput && candidate.cellIndex === cell.cellIndex,
          )) existing.cells.push(cell);
        }
      } else {
        records.set(record.txHash, record);
      }
    }
  }

  const sorted = Array.from(records.values())
    .sort((left, right) => (left.blockNumber > right.blockNumber ? -1 : 1));
  const hasMore = sorted.length > limit;
  const messages = [];

  for (const record of sorted.slice(0, limit)) {
    try {
      const response = await client.getTransaction(record.txHash);
      if (!response) continue;
      const tx = response.transaction;
      const inputRecord = record.cells.find((cell) => cell.isInput);
      const outputRecord = record.cells.find((cell) => !cell.isInput);
      const inputIndex = inputRecord ? Number(inputRecord.cellIndex) : undefined;
      const outputIndex = outputRecord ? Number(outputRecord.cellIndex) : undefined;
      const message = parseMessage(tx, inputIndex);
      if (!message) continue;

      let inputCapacity;
      if (inputIndex !== undefined) {
        const inputCell = await client.getCell(tx.inputs[inputIndex].previousOutput);
        inputCapacity = inputCell?.cellOutput.capacity;
      }
      const outputCapacity = outputIndex === undefined
        ? undefined
        : tx.outputs[outputIndex]?.capacity;
      let timestamp;
      try {
        timestamp = (await client.getHeaderByNumber(record.blockNumber))?.timestamp;
      } catch {}

      messages.push({
        txHash: record.txHash,
        status: response.status,
        blockNumber: (response.blockNumber ?? record.blockNumber)?.toString(),
        timestampMs: timestamp?.toString(),
        author: message.author,
        ...payloadJson(message.payload, full),
        inputCapacityCkb: inputCapacity === undefined ? undefined : ccc.fixedPointToString(inputCapacity),
        outputCapacityCkb: outputCapacity === undefined ? undefined : ccc.fixedPointToString(outputCapacity),
        capacityDeltaCkb:
          inputCapacity === undefined || outputCapacity === undefined
            ? undefined
            : signedCapacity(outputCapacity - inputCapacity),
        explorerUrl: `${EXPLORER_TX_URL}${record.txHash}`,
      });
    } catch {}
  }
  return { messages, hasMore };
}

async function channelsCommand() {
  const channels = await discoverChannels();
  emit({
    status: "ok",
    action: "channels",
    network: DEPLOYMENT.network ?? "testnet",
    rpcUrl: RPC_URL,
    count: channels.length,
    channels: channels.map(({ cells, ...channel }) => channel),
  });
}

async function channelCommand(channelHash, limit, full) {
  const channels = await discoverChannels();
  const channel = channels.find((candidate) => candidate.channelHash === channelHash);
  if (!channel) {
    fail(`channel not found: ${channelHash}`);
    return;
  }
  const history = await messageHistory(channel, limit, full);
  const { cells, ...summary } = channel;
  emit({
    status: "ok",
    action: "channel",
    network: DEPLOYMENT.network ?? "testnet",
    rpcUrl: RPC_URL,
    channel: {
      ...summary,
      ...(full ? {
        cells: cells.map((entry) => ({
          outPoint: outPointJson(entry.cell.outPoint),
          capacityCkb: ccc.fixedPointToString(entry.cell.cellOutput.capacity),
          maxFeeCkb: ccc.fixedPointToString(entry.maxFee),
          outputDataBytes: ccc.bytesFrom(entry.cell.outputData).length,
        })),
      } : {}),
    },
    messageCount: history.messages.length,
    hasMoreMessages: history.hasMore,
    messages: history.messages,
  });
}

async function txCommand(txHash) {
  const response = await client.getTransaction(txHash);
  if (!response) {
    emit({
      status: "ok",
      action: "transaction",
      network: DEPLOYMENT.network ?? "testnet",
      txHash,
      transactionStatus: "not_found",
      explorerUrl: `${EXPLORER_TX_URL}${txHash}`,
    });
    return;
  }
  const tx = response.transaction;
  let fee;
  try {
    fee = await tx.getFee(client);
  } catch {}
  const outputCapacity = tx.outputs.reduce((sum, output) => sum + output.capacity, 0n);
  emit({
    status: "ok",
    action: "transaction",
    network: DEPLOYMENT.network ?? "testnet",
    rpcUrl: RPC_URL,
    txHash,
    transactionStatus: response.status,
    blockNumber: response.blockNumber?.toString(),
    inputCount: tx.inputs.length,
    outputCount: tx.outputs.length,
    outputCapacityCkb: ccc.fixedPointToString(outputCapacity),
    feeShannon: fee?.toString(),
    feeCkb: fee === undefined ? undefined : ccc.fixedPointToString(fee),
    explorerUrl: `${EXPLORER_TX_URL}${txHash}`,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (command === "channels") {
    await channelsCommand();
    return;
  }
  if (command === "channel") {
    const channelHash = hashValue(args.shift(), "channel hash");
    let limit = 50;
    let full = false;
    while (args.length > 0) {
      const option = args.shift();
      if (option === "--limit") {
        limit = Number(args.shift());
      } else if (option === "--full") {
        full = true;
      } else {
        throw new Error(`unknown channel option: ${option}`);
      }
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("history limit must be between 1 and 100");
    }
    await channelCommand(channelHash, limit, full);
    return;
  }
  if (command === "tx") {
    await txCommand(hashValue(args.shift(), "transaction hash"));
    return;
  }
  throw new Error("usage: comp-query.mjs channels | channel HASH [--limit N] | tx HASH");
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
