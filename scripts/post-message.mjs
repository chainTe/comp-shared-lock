import { ccc } from "@ckb-ccc/shell";
import { readFileSync } from "fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";

const deployment = JSON.parse(readFileSync(new URL("../deployment.json", import.meta.url)));
const client = new ccc.ClientPublicTestnet();
const MESSAGE_FEE_RATE = 3600n;
const MAX_MESSAGE_FEE = BigInt(deployment.sharedCell.maxFeeShannon);
const RELATIVE_BLOCK_SINCE_ONE = 0x8000000000000001n;

const compLock = ccc.Script.from({
  codeHash: deployment.codeHash,
  hashType: deployment.hashType,
  args: deployment.sharedCell.lockArgs,
});

async function findSharedCell() {
  const cells = [];
  for await (const cell of client.findCells({ script: compLock, scriptType: "lock" }, "desc", 10)) {
    cells.push(cell);
  }
  if (cells.length !== 1) throw new Error(`expected 1 shared cell, got ${cells.length}`);
  return cells[0];
}

async function waitCommitted(txHash) {
  for (;;) {
    const tx = await client.getTransaction(txHash);
    if (tx && tx.status === "committed") return;
    if (tx && tx.status === "rejected") throw new Error("tx rejected");
    await new Promise((r) => setTimeout(r, 6000));
    process.stdout.write(".");
  }
}

function buildMessage({ publicKey = null, signature = null, payload }) {
  const extensions = JSON.stringify({
    protocol: "comp",
    version: 2,
    type: "text",
    payload,
  });
  return JSON.stringify({ public_key: publicKey, signature, extensions: JSON.parse(extensions) });
}

async function postMessage({ payload, signerKey = null }) {
  const cell = await findSharedCell();
  console.log("shared cell:", cell.outPoint.txHash, cell.outPoint.index.toString(),
    "capacity:", ccc.fixedPointToString(cell.cellOutput.capacity), "CKB");

  const tx = ccc.Transaction.from({
    cellDeps: [
      {
        outPoint: {
          txHash: deployment.contractOutPoint.txHash,
          index: deployment.contractOutPoint.index,
        },
        depType: "code",
      },
    ],
    inputs: [{
      previousOutput: cell.outPoint,
      since: RELATIVE_BLOCK_SINCE_ONE,
    }],
    outputs: [{ lock: compLock, capacity: cell.cellOutput.capacity }],
    outputsData: [cell.outputData],
  });
  if (signerKey) {
    // signed message: signature = secp256k1(blake2b(tx_hash || blake2b(0x00*65 || ext)))
    const msgPriv = ccc.bytesFrom(signerKey);
    const pubkey = secp256k1.getPublicKey(msgPriv, true);
    const publicKey = ccc.hexFrom(pubkey);

    const extensionsJson = JSON.stringify({
      protocol: "comp", version: 2, type: "text", payload,
    });
    const zeroSignature = `0x${"00".repeat(65)}`;
    tx.setWitnessArgsAt(0, ccc.WitnessArgs.from({
      lock: ccc.bytesFrom(JSON.stringify({
        public_key: `0x${"00".repeat(33)}`,
        signature: zeroSignature,
        extensions: JSON.parse(extensionsJson),
      }), "utf8"),
    }));
    payMessageFeeFromSharedCell(tx, cell.cellOutput.capacity);

    const messageBytes = ccc.bytesConcat(
      new Uint8Array(65),
      ccc.bytesFrom(extensionsJson, "utf8"),
    );
    const messageHash = ccc.hashCkb(messageBytes);
    const txHash = ccc.bytesFrom(tx.hash());
    const digest = ccc.hashCkb(ccc.bytesConcat(txHash, messageHash));
    const recovered = secp256k1.sign(ccc.bytesFrom(digest), msgPriv, { prehash: false, format: "recovered" });
    // noble returns [recid, r, s]; the contract expects [r, s, recid]
    const sigBytes = ccc.bytesConcat(recovered.slice(1), recovered.slice(0, 1));
    const witnessJson = JSON.stringify({
      public_key: publicKey,
      signature: ccc.hexFrom(sigBytes),
      extensions: JSON.parse(extensionsJson),
    });
    const witness = ccc.WitnessArgs.from({ lock: ccc.bytesFrom(witnessJson, "utf8") });
    tx.setWitnessArgsAt(0, witness);
    console.log("signed by public key:", publicKey);
  } else {
    const witnessJson = buildMessage({ payload });
    const witness = ccc.WitnessArgs.from({ lock: ccc.bytesFrom(witnessJson, "utf8") });
    tx.setWitnessArgsAt(0, witness);
    payMessageFeeFromSharedCell(tx, cell.cellOutput.capacity);
  }

  const txHash = await client.sendTransaction(tx);
  console.log("tx sent:", txHash);
  await waitCommitted(txHash);
  console.log("committed");
}

function payMessageFeeFromSharedCell(tx, inputCapacity) {
  const fee = tx.estimateFee(MESSAGE_FEE_RATE);
  if (fee > MAX_MESSAGE_FEE) {
    throw new Error(`message fee ${fee} exceeds shared Cell max_fee ${MAX_MESSAGE_FEE}`);
  }
  if (fee >= inputCapacity) throw new Error("shared Cell capacity too low");
  tx.outputs[0].capacity = inputCapacity - fee;
  console.log("shared cell fee:", fee.toString(), "shannon");
}

const mode = process.argv[2] || "anonymous";
if (mode === "anonymous") {
  await postMessage({ payload: "hello from COMP anonymous message (on-chain e2e)" });
} else if (mode === "signed") {
  // use a different key as the message author
  const authorKey = ccc.hexFrom(secp256k1.utils.randomSecretKey());
  await postMessage({ payload: "hello from COMP signed message (on-chain e2e)", signerKey: authorKey });
} else {
  throw new Error("usage: node post-message.mjs [anonymous|signed]");
}
process.exit(0)
