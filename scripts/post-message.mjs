import { ccc } from "@ckb-ccc/shell";
import { readFileSync } from "fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";

const PRIVATE_KEY = process.env.COMP_DEPLOY_KEY;
if (!PRIVATE_KEY) process.exit(1);

const deployment = JSON.parse(readFileSync(new URL("../deployment.json", import.meta.url)));
const client = new ccc.ClientPublicTestnet();
const signer = new ccc.SignerCkbPrivateKey(client, PRIVATE_KEY);

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

function buildMessage({ address = null, signature = null, payload }) {
  const extensions = JSON.stringify({
    protocol: "comp",
    version: 1,
    type: "text",
    payload,
  });
  return JSON.stringify({ address, signature, extensions: JSON.parse(extensions) });
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
    inputs: [{ previousOutput: cell.outPoint }],
    outputs: [{ lock: compLock, capacity: cell.cellOutput.capacity }],
    outputsData: [cell.outputData],
  });
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, 3600);

  if (signerKey) {
    // signed message: signature = secp256k1(blake2b(tx_hash || blake2b(addr || 0x00*65 || ext)))
    const msgPriv = ccc.bytesFrom(signerKey);
    const pubkey = secp256k1.getPublicKey(msgPriv, true);
    const lockArgs = ccc.bytesFrom(ccc.hashCkb(pubkey)).slice(0, 20);
    const sigScript = await ccc.Script.fromKnownScript(client, "Secp256k1Blake160", ccc.hexFrom(lockArgs));
    const address = await ccc.Address.fromScript(sigScript, client);
    const addressStr = address.toString();

    const extensionsJson = JSON.stringify({
      protocol: "comp", version: 1, type: "text", payload,
    });
    const messageBytes = ccc.bytesConcat(
      ccc.bytesFrom(addressStr, "utf8"),
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
      address: addressStr,
      signature: ccc.hexFrom(sigBytes),
      extensions: JSON.parse(extensionsJson),
    });
    const witness = ccc.WitnessArgs.from({ lock: ccc.bytesFrom(witnessJson, "utf8") });
    tx.setWitnessArgsAt(0, witness);
    console.log("signed by:", addressStr);
  } else {
    const witnessJson = buildMessage({ payload });
    const witness = ccc.WitnessArgs.from({ lock: ccc.bytesFrom(witnessJson, "utf8") });
    tx.setWitnessArgsAt(0, witness);
  }

  const txHash = await signer.sendTransaction(tx);
  console.log("tx sent:", txHash);
  await waitCommitted(txHash);
  console.log("committed");
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
