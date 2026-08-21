#!/usr/bin/env node
import { ccc } from "@ckb-ccc/shell";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const deployment = JSON.parse(
  readFileSync(new URL("../deployment.json", import.meta.url), "utf8"),
);

const RPC_URL = process.env.COMP_CKB_RPC ?? deployment.rpcUrl ?? "https://testnet.ckb.dev/";
const EXPLORER_TX_URL = "https://pudge.explorer.nervos.org/transaction/";
const MESSAGE_FEE_RATE = 3600n;
const MIN_CELL_CAPACITY = 61n * 10n ** 8n;
const RELATIVE_BLOCK_SINCE_ONE = 0x8000000000000001n;
const DRAFT_TTL_MS = 30 * 60 * 1000;
const MAX_MESSAGE_BYTES = 16 * 1024;
const RETRY_DELAYS_MS = [500, 1000, 2000];

const client = new ccc.ClientPublicTestnet({ url: RPC_URL });

function emit(value, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exitCode = exitCode;
}

function fail(message, exitCode = 2) {
  emit({ status: "error", message }, exitCode);
}

function hashValue(value, label) {
  if (!/^0x[0-9a-f]{64}$/i.test(value ?? "")) {
    throw new Error(`${label} must be a 0x-prefixed 32-byte hash`);
  }
  return value.toLowerCase();
}

function parseCompArgs(args) {
  const bytes = ccc.bytesFrom(args);
  if (bytes.length !== 40) return undefined;
  const channelHash = ccc.hexFrom(bytes.slice(0, 32));
  const view = new DataView(bytes.buffer, bytes.byteOffset + 32, 8);
  return { channelHash, maxFee: view.getBigUint64(0, true) };
}

function messageValue(value) {
  const message = String(value ?? "").trim();
  if (!message) throw new Error("message must not be empty");
  const byteLength = new TextEncoder().encode(message).length;
  if (byteLength > MAX_MESSAGE_BYTES) {
    throw new Error(`message is ${byteLength} bytes; maximum is ${MAX_MESSAGE_BYTES}`);
  }
  return { message, byteLength };
}

function dataRoot() {
  const configured = process.env.COMP_DATA_DIR ?? process.env.PLUGIN_DATA;
  const root = configured ?? join(tmpdir(), "comp-shared-lock");
  mkdirSync(join(root, "drafts"), { recursive: true, mode: 0o700 });
  return root;
}

function draftPath(id, state = "draft") {
  if (!/^[0-9a-f-]{36}$/i.test(id ?? "")) throw new Error("invalid draft id");
  const suffix = state === "draft" ? ".json" : `.${state}.json`;
  return join(dataRoot(), "drafts", `${id}${suffix}`);
}

function readDraft(id, state = "draft") {
  let draft;
  try {
    draft = JSON.parse(readFileSync(draftPath(id, state), "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(`draft not found: ${id}`);
    }
    throw error;
  }
  if (draft.id !== id || draft.action !== "post-anonymous") {
    throw new Error("invalid draft file");
  }
  return draft;
}

function anonymousWitnessJson(payload) {
  return JSON.stringify({
    public_key: null,
    signature: null,
    extensions: { protocol: "comp", version: 2, type: "text", payload },
  });
}

async function findAvailableCells(channelHash) {
  const template = ccc.Script.from({
    codeHash: deployment.codeHash,
    hashType: deployment.hashType,
    args: "0x",
  });
  const cells = [];
  for await (const cell of client.findCells(
    { script: template, scriptType: "lock", scriptSearchMode: "prefix" },
    "desc",
    100,
  )) {
    const parsed = parseCompArgs(cell.cellOutput.lock.args);
    if (!parsed || parsed.channelHash.toLowerCase() !== channelHash) continue;
    cells.push({ cell, maxFee: parsed.maxFee });
  }
  return cells.sort((left, right) =>
    left.cell.cellOutput.capacity > right.cell.cellOutput.capacity ? -1 : 1
  );
}

function buildTransaction(entry, payload) {
  const { cell, maxFee } = entry;
  const inputCapacity = cell.cellOutput.capacity;
  const tx = ccc.Transaction.from({
    cellDeps: [{
      outPoint: {
        txHash: deployment.contractOutPoint.txHash,
        index: deployment.contractOutPoint.index,
      },
      depType: "code",
    }],
    inputs: [{
      previousOutput: cell.outPoint,
      since: RELATIVE_BLOCK_SINCE_ONE,
    }],
    outputs: [{
      lock: cell.cellOutput.lock,
      capacity: inputCapacity,
    }],
    outputsData: [cell.outputData],
  });
  tx.setWitnessArgsAt(
    0,
    ccc.WitnessArgs.from({
      lock: ccc.bytesFrom(anonymousWitnessJson(payload), "utf8"),
    }),
  );
  const fee = tx.estimateFee(MESSAGE_FEE_RATE);
  if (fee > maxFee) {
    throw new Error(`message fee ${fee} exceeds Cell max_fee ${maxFee}`);
  }
  if (inputCapacity <= fee + MIN_CELL_CAPACITY) {
    throw new Error("COMP Cell capacity is too low to pay this message fee");
  }
  tx.outputs[0].capacity = inputCapacity - fee;
  return { tx, fee, inputCapacity, outputCapacity: tx.outputs[0].capacity };
}

async function prepareLiveTransaction(channelHash, payload) {
  const entries = await findAvailableCells(channelHash);
  if (entries.length === 0) throw new Error(`channel not found: ${channelHash}`);
  const errors = [];
  for (const entry of entries) {
    try {
      const built = buildTransaction(entry, payload);
      return { ...built, entry, availableCellCount: entries.length };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`no available COMP Cell: ${errors[0] ?? "unknown reason"}`);
}

function isConflictError(error) {
  const message = String(error).toLowerCase();
  return ["duplicate", "conflict", "dead", "already in tx pool", "input"]
    .some((part) => message.includes(part));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function draftPost(channelHash, rawMessage) {
  const { message, byteLength } = messageValue(rawMessage);
  const live = await prepareLiveTransaction(channelHash, message);
  const now = Date.now();
  const draft = {
    version: 1,
    id: randomUUID(),
    action: "post-anonymous",
    network: deployment.network ?? "testnet",
    channelHash,
    message,
    messageBytes: byteLength,
    feeSource: "COMP Cell",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + DRAFT_TTL_MS).toISOString(),
  };
  writeFileSync(draftPath(draft.id), `${JSON.stringify(draft)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  emit({
    status: "ok",
    action: "draft-post-anonymous",
    requiresConfirmation: true,
    draftId: draft.id,
    network: draft.network,
    channelHash,
    message,
    messageBytes: byteLength,
    feeSource: draft.feeSource,
    estimatedFeeShannon: live.fee.toString(),
    estimatedCapacityAfterCkb: ccc.fixedPointToString(live.outputCapacity),
    availableCellCount: live.availableCellCount,
    expiresAt: draft.expiresAt,
    nextCommand: `send-draft ${draft.id} --confirmed`,
  });
}

function showDraft(id) {
  const draft = readDraft(id);
  emit({ status: "ok", action: "show-draft", ...draft });
}

async function sendDraft(id, confirmed) {
  if (!confirmed) {
    throw new Error("send-draft requires --confirmed after explicit user approval");
  }
  const draft = readDraft(id);
  if (Date.parse(draft.expiresAt) <= Date.now()) {
    throw new Error(`draft expired: ${id}`);
  }
  const sendingPath = draftPath(id, "sending");
  renameSync(draftPath(id), sendingPath);

  let lastError;
  try {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const live = await prepareLiveTransaction(draft.channelHash, draft.message);
        const txHash = await client.sendTransaction(live.tx);
        const result = {
          ...draft,
          status: "sent",
          txHash,
          transactionStatus: "pending",
          feeShannon: live.fee.toString(),
          capacityBeforeCkb: ccc.fixedPointToString(live.inputCapacity),
          capacityAfterCkb: ccc.fixedPointToString(live.outputCapacity),
          explorerUrl: `${EXPLORER_TX_URL}${txHash}`,
          sentAt: new Date().toISOString(),
        };
        writeFileSync(sendingPath, `${JSON.stringify(result)}\n`, {
          encoding: "utf8",
          flag: "w",
          mode: 0o600,
        });
        renameSync(sendingPath, draftPath(id, "sent"));
        emit(result);
        return;
      } catch (error) {
        lastError = error;
        if (!isConflictError(error) || attempt >= RETRY_DELAYS_MS.length) throw error;
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  } catch (error) {
    renameSync(sendingPath, draftPath(id));
    throw error;
  }
  throw lastError ?? new Error("failed to send draft");
}

function selfTest() {
  const channelHash = `0x${"ab".repeat(32)}`;
  if (hashValue(channelHash, "channel hash") !== channelHash) {
    throw new Error("hash normalization failed");
  }
  const { message, byteLength } = messageValue("hello COMP");
  if (message !== "hello COMP" || byteLength !== 10) {
    throw new Error("message validation failed");
  }
  const witness = JSON.parse(anonymousWitnessJson(message));
  if (witness.extensions.payload !== message || witness.extensions.version !== 2) {
    throw new Error("witness encoding failed");
  }
  emit({
    status: "ok",
    action: "self-test",
    checks: ["hash", "message", "anonymous-witness", "deployment"],
    network: deployment.network,
    codeHash: deployment.codeHash,
  });
}

function help() {
  emit({
    status: "ok",
    action: "help",
    commands: [
      "draft-post CHANNEL_HASH MESSAGE",
      "show-draft DRAFT_ID",
      "send-draft DRAFT_ID --confirmed",
      "self-test",
    ],
    environment: {
      COMP_CKB_RPC: "optional CKB RPC URL",
      COMP_DATA_DIR: "optional private directory for drafts",
    },
  });
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === "help" || command === "--help") return help();
  if (command === "self-test") return selfTest();
  if (command === "draft-post") {
    const channelHash = hashValue(args.shift(), "channel hash");
    if (args.length !== 1) throw new Error("usage: draft-post CHANNEL_HASH MESSAGE");
    return draftPost(channelHash, args[0]);
  }
  if (command === "show-draft") {
    if (args.length !== 1) throw new Error("usage: show-draft DRAFT_ID");
    return showDraft(args[0]);
  }
  if (command === "send-draft") {
    const id = args.shift();
    const confirmed = args.length === 1 && args[0] === "--confirmed";
    if (!id || (!confirmed && args.length > 0)) {
      throw new Error("usage: send-draft DRAFT_ID --confirmed");
    }
    return sendDraft(id, confirmed);
  }
  throw new Error(`unknown command: ${command}`);
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
