import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { ccc } from "@ckb-ccc/shell";

const ROOT = new URL("../", import.meta.url);
const BINARY_URL = process.env.COMP_CONTRACT_BINARY
  ? pathToFileURL(resolve(process.env.COMP_CONTRACT_BINARY))
  : new URL("build/release/comp-shared-lock", ROOT);
const DEPLOYMENT_URL = new URL("deployment.json", ROOT);
const ARTIFACT_DIR_URL = process.env.COMP_UPGRADE_ARTIFACT_DIR
  ? pathToFileURL(`${resolve(process.env.COMP_UPGRADE_ARTIFACT_DIR)}/`)
  : new URL(".codex-artifacts/type-id-upgrade/", ROOT);
const PREPARED_URL = new URL("prepared-upgrade-transaction.json", ARTIFACT_DIR_URL);
const NETWORK_VERIFICATION_URL = new URL("network-verification.json", ARTIFACT_DIR_URL);
const DEPLOYMENT_BACKUP_URL = new URL("deployment-before-upgrade.json", ARTIFACT_DIR_URL);

const FEE_RATE = parsePositiveInteger("COMP_FEE_RATE", 1000n);
const MIN_RESERVE_CKB = parsePositiveInteger("COMP_MIN_UPGRADE_RESERVE_CKB", 1000n);
const RPC_URL = process.env.COMP_CKB_RPC ?? "https://testnet.ckb.dev/";
const PRIVATE_KEY = process.env.COMP_DEPLOY_KEY;
const SEND_PREPARED = process.argv.includes("--send-prepared");

mkdirSync(ARTIFACT_DIR_URL, { recursive: true });

function parsePositiveInteger(name, fallback) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : BigInt(raw);
  if (value <= 0n) throw new Error(`${name} must be a positive integer`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(`upgrade invariant failed: ${message}`);
}

function writeJson(url, value) {
  writeFileSync(url, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function indexHex(index) {
  return `0x${BigInt(index).toString(16)}`;
}

function outPointFrom(record) {
  return {
    txHash: record.txHash,
    index: BigInt(record.index),
  };
}

function outPointEq(left, right) {
  return left.txHash === right.txHash && BigInt(left.index) === BigInt(right.index);
}

assert(existsSync(DEPLOYMENT_URL), "deployment.json is missing");
assert(existsSync(BINARY_URL), "contract binary is missing; run make build first");

const deployment = JSON.parse(readFileSync(DEPLOYMENT_URL, "utf8"));
assert(deployment.network === "testnet", "deployment is not testnet");
assert(deployment.hashType === "type", "COMP lock is not Type ID-addressed");
assert(deployment.typeId?.script, "Type ID deployment metadata is missing");

const client = new ccc.ClientPublicTestnet({ url: RPC_URL });
const binary = readFileSync(BINARY_URL);
const binaryBytes = ccc.bytesFrom(binary);
const binaryHex = ccc.hexFrom(binaryBytes);
const binarySha256 = sha256(binary);
const dataHash = ccc.hexFrom(ccc.hashCkb(binaryBytes));
const currentOutPoint = outPointFrom(deployment.contractOutPoint);
const expectedTypeScript = ccc.Script.from(deployment.typeId.script);
const expectedTypeHash = expectedTypeScript.hash();

assert(expectedTypeHash === deployment.codeHash, "stored Type ID hash does not match codeHash");

async function createSigner(lock) {
  if (PRIVATE_KEY) {
    const signer = new ccc.SignerCkbPrivateKey(client, PRIVATE_KEY);
    const address = await signer.getRecommendedAddress();
    assert(address === deployment.deployer, "COMP_DEPLOY_KEY does not match deployment owner");
    const signerLock = (await signer.getRecommendedAddressObj()).script;
    assert(signerLock.eq(lock), "deployment key does not control the code-cell lock");
    return { signer, address, canSign: true };
  }

  return {
    signer: new ccc.SignerCkbScriptReadonly(client, lock),
    address: deployment.deployer,
    canSign: false,
  };
}

async function loadCurrentCodeCell() {
  const cell = await client.getCellLive(currentOutPoint, true);
  assert(cell, "current code cell is not live");
  assert(cell.cellOutput.type?.eq(expectedTypeScript), "live Type ID script changed");
  assert(cell.cellOutput.type?.hash() === deployment.codeHash, "live Type ID hash changed");
  assert(
    ccc.hashCkb(cell.outputData) === deployment.dataHash,
    "live code data hash differs from deployment.json",
  );
  return cell;
}

async function buildUpgrade(currentCell, signer) {
  const tx = ccc.Transaction.from({
    inputs: [{ previousOutput: currentCell.outPoint }],
    outputs: [currentCell.cellOutput],
    outputsData: [binaryHex],
  });

  await tx.prepareSighashAllWitness(currentCell.cellOutput.lock, 65, client);
  await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.Secp256k1Blake160);

  const fee = tx.estimateFee(FEE_RATE);
  assert(fee < tx.outputs[0].capacity, "upgrade fee consumes the code cell");
  tx.outputs[0].capacity -= fee;

  const confirmedFee = await tx.getFee(client);
  assert(confirmedFee === fee, "calculated upgrade fee changed");
  assert(tx.outputs[0].lock.eq(currentCell.cellOutput.lock), "code-cell lock changed");
  assert(tx.outputs[0].type?.eq(expectedTypeScript), "Type ID script changed");
  assert(ccc.hashCkb(tx.outputsData[0]) === dataHash, "replacement binary hash changed");

  const replacement = ccc.CellAny.from({
    cellOutput: tx.outputs[0],
    outputData: tx.outputsData[0],
  });
  const minimumCapacity = ccc.fixedPointFrom(replacement.occupiedSize);
  const reserveAfter = tx.outputs[0].capacity - minimumCapacity;
  assert(
    reserveAfter >= ccc.fixedPointFrom(MIN_RESERVE_CKB.toString()),
    `remaining code-cell reserve is below ${MIN_RESERVE_CKB} CKB`,
  );

  return { tx, fee, minimumCapacity, reserveAfter, signer };
}

function verifyPreparedTransaction(tx, currentCell) {
  assert(tx.inputs.length === 1, "prepared transaction must have one input");
  assert(
    outPointEq(tx.inputs[0].previousOutput, currentOutPoint),
    "prepared input is not the current code cell",
  );
  assert(tx.outputs.length === 1, "prepared transaction must have one output");
  assert(tx.outputsData.length === 1, "prepared outputsData length changed");
  assert(tx.outputs[0].lock.eq(currentCell.cellOutput.lock), "prepared lock changed");
  assert(tx.outputs[0].type?.eq(expectedTypeScript), "prepared Type ID changed");
  assert(ccc.hashCkb(tx.outputsData[0]) === dataHash, "prepared binary changed");
  assert(tx.outputs[0].capacity < currentCell.cellOutput.capacity, "prepared fee is missing");
}

async function waitCommitted(txHash, timeoutMs = 600_000) {
  const started = Date.now();
  for (;;) {
    const response = await client.getTransaction(txHash);
    if (response?.status === "rejected") {
      throw new Error(`upgrade transaction rejected: ${txHash}`);
    }
    if (response?.status === "committed" || response?.blockNumber !== undefined) {
      return response;
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`upgrade confirmation timeout: ${txHash}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 6000));
  }
}

async function verifyCommittedUpgrade(txHash, outputIndex) {
  const nextOutPoint = { txHash, index: BigInt(outputIndex) };
  const [oldCell, nextCell] = await Promise.all([
    client.getCellLive(currentOutPoint, true),
    client.getCellLive(nextOutPoint, true),
  ]);
  assert(!oldCell, "previous code cell is still live");
  assert(nextCell, "replacement code cell is not live");
  assert(nextCell.cellOutput.type?.eq(expectedTypeScript), "committed Type ID changed");
  assert(nextCell.cellOutput.type?.hash() === deployment.codeHash, "committed codeHash changed");
  assert(ccc.hashCkb(nextCell.outputData) === dataHash, "committed binary hash changed");
  return { nextOutPoint, nextCell };
}

const currentCell = await loadCurrentCodeCell();
const { signer, address, canSign } = await createSigner(currentCell.cellOutput.lock);

let plan;
if (SEND_PREPARED) {
  assert(canSign, "COMP_DEPLOY_KEY is required with --send-prepared");
  assert(existsSync(PREPARED_URL), "prepared upgrade transaction is missing");
  const prepared = JSON.parse(readFileSync(PREPARED_URL, "utf8"));
  assert(prepared.binarySha256 === binarySha256, "prepared binary sha256 changed");
  assert(prepared.dataHash === dataHash, "prepared binary data hash changed");
  assert(outPointEq(prepared.previousContractOutPoint, currentOutPoint), "prepared source changed");
  const tx = ccc.Transaction.from(prepared.transaction);
  verifyPreparedTransaction(tx, currentCell);
  assert(tx.hash() === prepared.txHash, "prepared raw transaction hash changed");
  const fee = await tx.getFee(client);
  const replacement = ccc.CellAny.from({
    cellOutput: tx.outputs[0],
    outputData: tx.outputsData[0],
  });
  const minimumCapacity = ccc.fixedPointFrom(replacement.occupiedSize);
  plan = {
    tx,
    fee,
    minimumCapacity,
    reserveAfter: tx.outputs[0].capacity - minimumCapacity,
  };
} else {
  plan = await buildUpgrade(currentCell, signer);
}

const rawTxHash = plan.tx.hash();
const outputIndex = 0;
console.log("network: testnet");
console.log("deployer:", address);
console.log("previous code cell:", currentOutPoint.txHash, indexHex(currentOutPoint.index));
console.log("binary sha256:", binarySha256);
console.log("binary data hash:", dataHash);
console.log("preserved Type ID hash / COMP code_hash:", expectedTypeHash);
console.log("raw transaction hash:", rawTxHash);
console.log("fee:", plan.fee.toString(), "shannon");
console.log("reserve after upgrade:", ccc.fixedPointToString(plan.reserveAfter), "CKB");

if (!canSign) {
  const preparedAt = new Date().toISOString();
  writeJson(PREPARED_URL, {
    kind: "ckb-type-id-contract-upgrade-transaction",
    network: "testnet",
    rpcUrl: RPC_URL,
    status: "prepared-for-signing",
    deployer: address,
    previousContractOutPoint: {
      txHash: currentOutPoint.txHash,
      index: indexHex(currentOutPoint.index),
    },
    nextContractOutPoint: { txHash: rawTxHash, index: indexHex(outputIndex) },
    binarySha256,
    dataHash,
    binaryBytes: binary.length,
    typeHash: expectedTypeHash,
    txHash: rawTxHash,
    feeShannon: plan.fee.toString(),
    reserveAfterShannon: plan.reserveAfter.toString(),
    transaction: JSON.parse(plan.tx.stringify()),
    preparedAt,
  });
  console.log("prepared transaction:", PREPARED_URL.pathname);
  console.log(
    "broadcast command: COMP_DEPLOY_KEY=<private-key> node upgrade.mjs --send-prepared",
  );
  process.exit(0);
}

const signedTx = await signer.signTransaction(plan.tx);
assert(signedTx.hash() === rawTxHash, "signing changed the raw transaction hash");
const txHash = await client.sendTransaction(signedTx);
assert(txHash === rawTxHash, "RPC returned an unexpected transaction hash");
console.log("upgrade transaction sent:", txHash);
const confirmation = await waitCommitted(txHash);
console.log("upgrade transaction committed:", txHash);

const { nextOutPoint, nextCell } = await verifyCommittedUpgrade(txHash, outputIndex);
const verifiedAt = new Date().toISOString();
writeJson(NETWORK_VERIFICATION_URL, {
  checkedAt: verifiedAt,
  transactionStatus: "committed",
  txHash,
  blockHash: confirmation?.blockHash,
  blockNumber: confirmation?.blockNumber?.toString(),
  previousCodeCell: {
    outPoint: deployment.contractOutPoint,
    live: false,
    dataHash: deployment.dataHash,
  },
  replacementCodeCell: {
    outPoint: { txHash: nextOutPoint.txHash, index: indexHex(nextOutPoint.index) },
    live: true,
    dataHash,
    typeHash: nextCell.cellOutput.type.hash(),
    binarySha256,
  },
});

writeFileSync(DEPLOYMENT_BACKUP_URL, readFileSync(DEPLOYMENT_URL));
const upgradeHistory = Array.isArray(deployment.upgradeHistory)
  ? deployment.upgradeHistory
  : [];
upgradeHistory.push({
  txHash,
  previousContractOutPoint: deployment.contractOutPoint,
  contractOutPoint: { txHash, index: indexHex(outputIndex) },
  previousDataHash: deployment.dataHash,
  dataHash,
  binarySha256,
  feeShannon: plan.fee.toString(),
  upgradedAt: verifiedAt,
});

writeJson(DEPLOYMENT_URL, {
  ...deployment,
  rpcUrl: RPC_URL,
  contractVersion: "0.3.0",
  codeHash: expectedTypeHash,
  hashType: "type",
  dataHash,
  binarySha256,
  binaryBytes: binary.length,
  contractOutPoint: { txHash, index: indexHex(outputIndex) },
  codeCellReserveCkb: ccc.fixedPointToString(plan.reserveAfter),
  codeCellReserveShannon: plan.reserveAfter.toString(),
  requiredSince: {
    metric: "relative-block-number",
    value: "1",
    encoded: "0x8000000000000001",
  },
  upgradeHistory,
  upgradedAt: verifiedAt,
});

console.log("deployment record:", DEPLOYMENT_URL.pathname);
console.log("network verification:", NETWORK_VERIFICATION_URL.pathname);
