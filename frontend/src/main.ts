import { ccc } from "@ckb-ccc/shell";
import { secp256k1 } from "@noble/curves/secp256k1.js";

// Default testnet deployment (overridable via UI later if needed)
const DEPLOYMENT = {
  codeHash: "0x43fd8315fd9d20de67b2d26ea713b9fff034877d22fec2c5f51ad8a065ac12d9",
  hashType: "data2" as const,
  contractOutPoint: {
    txHash: "0xcd56cc438ae1f6697de904cb8b12411beda44bb8a7f111ebc3520c9b90ebab95",
    index: "0x0",
  },
  sharedCell: {
    lockArgs:
      "0x3bf471b16283375362945f60972e6dd4a998db34b53623457dcaa800b6a4272640420f0000000000",
    maxFeeShannon: "1000000",
  },
};

const client = new ccc.ClientPublicTestnet();

const compLock = ccc.Script.from({
  codeHash: DEPLOYMENT.codeHash,
  hashType: DEPLOYMENT.hashType,
  args: DEPLOYMENT.sharedCell.lockArgs,
});

const $ = (id: string) => document.getElementById(id)!;
const logEl = $("log");

function log(msg: string, cls = "") {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.prepend(line);
}

function getFeeSigner(): ccc.Signer {
  const key = ($("feeKey") as HTMLInputElement).value.trim();
  if (!key) throw new Error("fee payer private key required");
  return new ccc.SignerCkbPrivateKey(client, key);
}

async function findSharedCell() {
  const cells: ccc.Cell[] = [];
  for await (const cell of client.findCells(
    { script: compLock, scriptType: "lock", scriptSearchMode: "exact" },
    "desc",
    10,
  )) {
    cells.push(cell);
  }
  if (cells.length !== 1) {
    throw new Error(`expected exactly 1 live shared cell, found ${cells.length}`);
  }
  return cells[0];
}

async function refresh() {
  try {
    const cell = await findSharedCell();
    $("cellInfo").textContent = JSON.stringify(
      {
        outPoint: {
          txHash: cell.outPoint.txHash,
          index: cell.outPoint.index.toString(),
        },
        capacityCKB: ccc.fixedPointToString(cell.cellOutput.capacity),
        data: cell.outputData,
        dataUtf8: (() => {
          try {
            return new TextDecoder().decode(ccc.bytesFrom(cell.outputData));
          } catch {
            return "(binary)";
          }
        })(),
      },
      null,
      2,
    );
  } catch (e) {
    $("cellInfo").textContent = String(e);
  }
}

function extensionsJson(payload: string): string {
  return JSON.stringify({ protocol: "comp", version: 1, type: "text", payload });
}

async function buildBaseTx(signer: ccc.Signer, extraCapacity: bigint = 0n) {
  const cell = await findSharedCell();
  const tx = ccc.Transaction.from({
    cellDeps: [
      {
        outPoint: {
          txHash: DEPLOYMENT.contractOutPoint.txHash,
          index: DEPLOYMENT.contractOutPoint.index,
        },
        depType: "code",
      },
    ],
    inputs: [{ previousOutput: cell.outPoint }],
    outputs: [
      { lock: compLock, capacity: cell.cellOutput.capacity + extraCapacity },
    ],
    outputsData: [cell.outputData],
  });
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, 3600);
  return { tx, cell };
}

async function postAnonymous() {
  const signer = getFeeSigner();
  const payload = ($("anonPayload") as HTMLTextAreaElement).value;
  const { tx } = await buildBaseTx(signer);
  const witnessJson = JSON.stringify({
    address: null,
    signature: null,
    extensions: JSON.parse(extensionsJson(payload)),
  });
  tx.setWitnessArgsAt(
    0,
    ccc.WitnessArgs.from({ lock: ccc.bytesFrom(witnessJson, "utf8") }),
  );
  const txHash = await signer.sendTransaction(tx);
  log(`anonymous message sent: ${txHash}`, "ok");
  log(`explorer: https://pudge.explorer.nervos.org/transaction/${txHash}`, "ok");
}

async function postSigned() {
  const signer = getFeeSigner();
  const payload = ($("signedPayload") as HTMLTextAreaElement).value;

  let authorKeyHex = ($("authorKey") as HTMLInputElement).value.trim();
  if (!authorKeyHex) {
    authorKeyHex = ccc.hexFrom(secp256k1.utils.randomSecretKey());
    ($("authorKey") as HTMLInputElement).value = authorKeyHex;
    log(`generated author key: ${authorKeyHex} (save it to keep your identity)`);
  }
  const authorKey = ccc.bytesFrom(authorKeyHex);

  const { tx } = await buildBaseTx(signer);

  const pubkey = secp256k1.getPublicKey(authorKey, true);
  const lockArgs = ccc.bytesFrom(ccc.hashCkb(pubkey)).slice(0, 20);
  const sigScript = await ccc.Script.fromKnownScript(
    client,
    ccc.KnownScript.Secp256k1Blake160,
    ccc.hexFrom(lockArgs),
  );
  const address = (await ccc.Address.fromScript(sigScript, client)).toString();

  const extJson = extensionsJson(payload);
  // canonical_encode(address, ZERO_SIGNATURE, extensions)
  const messageBytes = ccc.bytesConcat(
    ccc.bytesFrom(address, "utf8"),
    new Uint8Array(65),
    ccc.bytesFrom(extJson, "utf8"),
  );
  const messageHash = ccc.hashCkb(messageBytes);
  // signing_digest = hash(tx_hash || message_hash)
  const digest = ccc.hashCkb(
    ccc.bytesConcat(ccc.bytesFrom(tx.hash()), ccc.bytesFrom(messageHash)),
  );
  const sig = secp256k1.sign(ccc.bytesFrom(digest), authorKey, {
    prehash: false,
  });
  const sigBytes = ccc.bytesConcat(
    sig.toCompactRawBytes(),
    new Uint8Array([sig.recovery ?? 0]),
  );

  const witnessJson = JSON.stringify({
    address,
    signature: ccc.hexFrom(sigBytes),
    extensions: JSON.parse(extJson),
  });
  tx.setWitnessArgsAt(
    0,
    ccc.WitnessArgs.from({ lock: ccc.bytesFrom(witnessJson, "utf8") }),
  );
  const txHash = await signer.sendTransaction(tx);
  log(`signed message sent by ${address}: ${txHash}`, "ok");
  log(`explorer: https://pudge.explorer.nervos.org/transaction/${txHash}`, "ok");
}

async function sponsor() {
  const signer = getFeeSigner();
  const amount = BigInt(($("sponsorAmount") as HTMLInputElement).value);
  const { tx } = await buildBaseTx(signer, ccc.fixedPointFrom(amount));
  const txHash = await signer.sendTransaction(tx);
  log(`sponsored ${amount} CKB: ${txHash}`, "ok");
}

async function guard(id: string, fn: () => Promise<void>) {
  const btn = $(id) as HTMLButtonElement;
  btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    log(String(e), "err");
  } finally {
    btn.disabled = false;
    refresh();
  }
}

$("refresh").addEventListener("click", () => void refresh());
$("postAnon").addEventListener("click", () => void guard("postAnon", postAnonymous));
$("postSigned").addEventListener("click", () => void guard("postSigned", postSigned));
$("sponsor").addEventListener("click", () => void guard("sponsor", sponsor));

($("feeKey") as HTMLInputElement).addEventListener("change", async () => {
  try {
    const addr = await (getFeeSigner() as any).getRecommendedAddress();
    $("feeAddr").textContent = `fee payer: ${addr}`;
  } catch {
    $("feeAddr").textContent = "";
  }
});

void refresh();
