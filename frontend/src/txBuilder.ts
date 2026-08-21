import { ccc } from "@ckb-ccc/shell";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { client, MESSAGE_FEE_RATE, RETRY_DELAYS_MS } from "./rpc";
import { loadDeployment } from "./config";
import { pickAvailableCell, resolveChannelState, trackPendingTx } from "./resolver";
import {
  anonymousWitnessJson,
  extensionsJson,
  signedWitnessJson,
  sleep,
} from "./utils";
import type { SigningIdentity } from "./types";

const ZERO_SIGNATURE = `0x${"00".repeat(65)}`;
const ZERO_PUBLIC_KEY = `0x${"00".repeat(33)}`;
const RELATIVE_BLOCK_SINCE_ONE = 0x8000000000000001n;

async function buildMessageTx(
  channelHash: string,
  payload: string,
  identity: SigningIdentity,
): Promise<{ tx: ccc.Transaction; cell: { outPoint: ccc.OutPoint; capacity: bigint }; inputCapacity: bigint }> {
  const cfg = await loadDeployment();

  const state = await resolveChannelState(channelHash);
  const cell = pickAvailableCell(state.liveCells);
  if (!cell) {
    throw new Error("no available COMP cell with enough capacity");
  }

  const tx = ccc.Transaction.from({
    cellDeps: [
      {
        outPoint: {
          txHash: cfg.contractOutPoint.txHash,
          index: cfg.contractOutPoint.index,
        },
        depType: "code",
      },
    ],
    inputs: [{
      previousOutput: cell.outPoint,
      since: RELATIVE_BLOCK_SINCE_ONE,
    }],
    outputs: [
      {
        lock: cell.cellOutput.lock,
        capacity: cell.cellOutput.capacity,
      },
    ],
    outputsData: [cell.outputData],
  });

  if (identity.mode === "anonymous") {
    tx.setWitnessArgsAt(
      0,
      ccc.WitnessArgs.from({ lock: ccc.bytesFrom(anonymousWitnessJson(payload), "utf8") }),
    );
  } else {
    if (!identity.signDigest) throw new Error("signed identity requires a signer");
    tx.setWitnessArgsAt(
      0,
      ccc.WitnessArgs.from({
        lock: ccc.bytesFrom(
          signedWitnessJson(ZERO_PUBLIC_KEY, ZERO_SIGNATURE, payload),
          "utf8",
        ),
      }),
    );
  }

  return { tx, cell: { outPoint: cell.outPoint, capacity: cell.cellOutput.capacity }, inputCapacity: cell.cellOutput.capacity };
}

function payMessageFeeFromSharedCell(tx: ccc.Transaction, inputCapacity: bigint, maxFee: bigint) {
  const fee = tx.estimateFee(MESSAGE_FEE_RATE);
  if (fee > maxFee) {
    throw new Error(
      `message fee ${fee} shannon exceeds channel max_fee ${maxFee}`,
    );
  }
  if (fee >= inputCapacity) {
    throw new Error("cell capacity is too low to pay the message fee");
  }
  tx.outputs[0].capacity = inputCapacity - fee;
  return fee;
}

async function finalizeSignedWitness(
  tx: ccc.Transaction,
  identity: SigningIdentity,
  payload: string,
): Promise<void> {
  if (identity.mode === "anonymous" || !identity.signDigest) {
    throw new Error("invalid identity for signed message");
  }

  const extJson = extensionsJson(payload);

  // message_hash = blake2b_256(65 zero bytes || utf8(extensions))
  const messageBytes = ccc.bytesConcat(
    new Uint8Array(65),
    ccc.bytesFrom(extJson, "utf8"),
  );
  const messageHash = ccc.hashCkb(messageBytes);

  // signing_digest = blake2b_256(tx_hash || message_hash)
  const digest = ccc.hashCkb(
    ccc.bytesConcat(ccc.bytesFrom(tx.hash()), ccc.bytesFrom(messageHash)),
  );

  const signature = await identity.signDigest(digest);
  const sigBytes = ccc.bytesFrom(signature);
  if (sigBytes.length !== 65) {
    throw new Error(`signer returned ${sigBytes.length}-byte signature; expected 65 bytes`);
  }
  const recovery = sigBytes[64] >= 27 && sigBytes[64] <= 28
    ? sigBytes[64] - 27
    : sigBytes[64];
  if (recovery > 3) throw new Error(`invalid recovery id ${sigBytes[64]}`);
  const recoveredPublicKey = ccc.hexFrom(
    secp256k1.Signature.fromCompact(sigBytes.slice(0, 64))
      .addRecoveryBit(recovery)
      .recoverPublicKey(ccc.bytesFrom(digest))
      .toRawBytes(true),
  );
  if (
    identity.publicKey &&
    identity.publicKey.toLowerCase() !== recoveredPublicKey.toLowerCase()
  ) {
    throw new Error("signature does not recover to the selected public key");
  }
  identity.publicKey = recoveredPublicKey;
  const witnessJson = signedWitnessJson(recoveredPublicKey, signature, payload);

  tx.setWitnessArgsAt(
    0,
    ccc.WitnessArgs.from({ lock: ccc.bytesFrom(witnessJson, "utf8") }),
  );
}

function isConflictError(e: unknown): boolean {
  const msg = String(e).toLowerCase();
  return (
    msg.includes("duplicate") ||
    msg.includes("conflict") ||
    msg.includes("dead") ||
    msg.includes("already in tx pool") ||
    msg.includes("input")
  );
}

async function sendWithRetry(
  channelHash: string,
  payload: string,
  identity: SigningIdentity,
  maxFee: bigint,
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const { tx, inputCapacity } = await buildMessageTx(channelHash, payload, identity);
      const fee = payMessageFeeFromSharedCell(tx, inputCapacity, maxFee);

      if (identity.mode !== "anonymous") {
        await finalizeSignedWitness(tx, identity, payload);
      }

      const txHash = await client.sendTransaction(tx);
      trackPendingTx(txHash, channelHash);
      return txHash;
    } catch (e) {
      lastError = e;
      if (!isConflictError(e) || attempt >= RETRY_DELAYS_MS.length) {
        throw e;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastError ?? new Error("failed to send message");
}

export async function postAnonymous(channelHash: string, payload: string): Promise<string> {
  const state = await resolveChannelState(channelHash);
  return sendWithRetry(
    channelHash,
    payload,
    { mode: "anonymous", publicKey: null, label: "Anonymous" },
    state.channel.maxFee,
  );
}

export async function postSigned(
  channelHash: string,
  payload: string,
  identity: SigningIdentity,
): Promise<string> {
  if (identity.mode === "anonymous") {
    throw new Error("use postAnonymous for anonymous messages");
  }
  const state = await resolveChannelState(channelHash);
  return sendWithRetry(channelHash, payload, identity, state.channel.maxFee);
}

export function guardButton(btn: HTMLButtonElement, fn: () => Promise<void>) {
  btn.disabled = true;
  fn().finally(() => {
    btn.disabled = false;
  });
}
