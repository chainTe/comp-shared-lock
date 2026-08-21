import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { ccc } from "@ckb-ccc/shell";

const ROOT = new URL("../", import.meta.url);
const BINARY_URL = new URL("build/release/comp-shared-lock", ROOT);
const DEPLOYMENT_URL = new URL("deployment.json", ROOT);
const ARTIFACT_DIR_URL = new URL(
  ".codex-artifacts/type-id-deployment/",
  ROOT,
);
const PREPARED_URL = new URL("prepared-type-id-transaction.json", ARTIFACT_DIR_URL);
const PREPARED_DEPLOYMENT_URL = new URL(
  "prepared-deployment.json",
  ARTIFACT_DIR_URL,
);
const NETWORK_VERIFICATION_URL = new URL(
  "network-verification.json",
  ARTIFACT_DIR_URL,
);
const DEPLOYMENT_BACKUP_URL = new URL(
  "deployment-before-type-id.json",
  ARTIFACT_DIR_URL,
);

const TYPE_ID_CODE_HASH =
  "0x00000000000000000000000000000000000000000000000000545950455f4944";
const FEE_RATE = parsePositiveInteger("COMP_FEE_RATE", 1000n);
const CODE_CELL_RESERVE_CKB = parsePositiveInteger(
  "COMP_CODE_CELL_RESERVE_CKB",
  5000n,
);
const SHARED_CELL_CKB = parsePositiveInteger("COMP_SHARED_CELL_CKB", 200n);
const MAX_FEE = parsePositiveInteger("COMP_MAX_FEE_SHANNON", 1_000_000n);
const RPC_URL = process.env.COMP_CKB_RPC ?? "https://testnet.ckb.dev/";
const PRIVATE_KEY = process.env.COMP_DEPLOY_KEY;
const SEND_PREPARED = process.argv.includes("--send-prepared");

mkdirSync(ARTIFACT_DIR_URL, { recursive: true });

function parsePositiveInteger(name, fallback) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : BigInt(raw);
  if (value <= 0n) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`deployment invariant failed: ${message}`);
  }
}

function writeJson(url, value) {
  writeFileSync(url, `${JSON.stringify(value, null, 2)}\n`);
}

function indexHex(index) {
  return `0x${index.toString(16)}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function previousDeployment() {
  if (!existsSync(DEPLOYMENT_URL)) return undefined;
  return JSON.parse(readFileSync(DEPLOYMENT_URL, "utf8"));
}

function deploymentAddressFromState() {
  return process.env.COMP_DEPLOY_ADDRESS ?? previousDeployment()?.deployer;
}

const client = new ccc.ClientPublicTestnet({ url: RPC_URL });
const binary = readFileSync(BINARY_URL);
const binaryBytes = ccc.bytesFrom(binary);
const dataHash = ccc.hexFrom(ccc.hashCkb(binaryBytes));
const binarySha256 = sha256(binary);
const channelHash = ccc.hexFrom(
  ccc.hashCkb(ccc.bytesFrom("comp-channel-general", "utf8")),
);
const maxFeeBytes = new Uint8Array(8);
new DataView(maxFeeBytes.buffer).setBigUint64(0, MAX_FEE, true);
const lockArgs = ccc.hexFrom(
  ccc.bytesConcat(ccc.bytesFrom(channelHash), maxFeeBytes),
);
const sharedData = ccc.bytesFrom("COMP shared cell #0", "utf8");

async function createSigner() {
  if (PRIVATE_KEY) {
    const signer = new ccc.SignerCkbPrivateKey(client, PRIVATE_KEY);
    const address = await signer.getRecommendedAddress();
    const expectedAddress = process.env.COMP_DEPLOY_ADDRESS;
    if (expectedAddress && expectedAddress !== address) {
      throw new Error(
        `COMP_DEPLOY_ADDRESS does not match COMP_DEPLOY_KEY: ${address}`,
      );
    }
    return { signer, address, canSign: true };
  }

  const address = deploymentAddressFromState();
  if (!address) {
    throw new Error(
      "set COMP_DEPLOY_ADDRESS to prepare a transaction or COMP_DEPLOY_KEY to broadcast it",
    );
  }
  const addressObj = await ccc.Address.fromString(address, client);
  return {
    signer: new ccc.SignerCkbScriptReadonly(client, addressObj.script),
    address,
    canSign: false,
  };
}

async function buildTransaction(signer, deployerLock) {
  const { tx, id: typeIdArgs, index: codeIndex } =
    await ccc.typeId.createTypeId({
      signer,
      receiver: deployerLock,
      data: binaryBytes,
    });

  tx.outputs[codeIndex].capacity += ccc.fixedPointFrom(
    CODE_CELL_RESERVE_CKB.toString(),
  );

  const typeIdScript = tx.outputs[codeIndex].type;
  assert(typeIdScript, "code cell must carry a Type ID script");
  const typeHash = typeIdScript.hash();
  const compLock = ccc.Script.from({
    codeHash: typeHash,
    hashType: "type",
    args: lockArgs,
  });
  const sharedIndex = tx.addOutput(
    {
      lock: compLock,
      capacity: ccc.fixedPointFrom(SHARED_CELL_CKB.toString()),
    },
    sharedData,
  ) - 1;

  await tx.completeInputsByCapacity(signer);

  // The readonly preparation path needs the same 65-byte sighash placeholder
  // and secp256k1 dep that the private-key signer will use when broadcasting.
  await tx.prepareSighashAllWitness(deployerLock, 65, client);
  await tx.addCellDepsOfKnownScripts(
    client,
    ccc.KnownScript.Secp256k1Blake160,
  );
  await tx.completeFeeBy(signer, FEE_RATE);

  const expectedTypeId = ccc.hashTypeId(tx.inputs[0], codeIndex);
  assert(typeIdArgs === expectedTypeId, "Type ID args must bind input[0] and output index");
  assert(typeIdScript.args === expectedTypeId, "code cell Type ID args changed");
  assert(typeIdScript.codeHash === TYPE_ID_CODE_HASH, "unexpected Type ID code hash");
  assert(typeIdScript.hashType === "type", "Type ID must use hash_type=type");
  assert(tx.outputs[codeIndex].type?.hash() === typeHash, "type hash changed");
  assert(compLock.codeHash === typeHash, "COMP lock must reference the Type ID hash");
  assert(compLock.hashType === "type", "COMP lock must use hash_type=type");
  assert(tx.outputs[sharedIndex].lock.eq(compLock), "shared cell lock changed");
  assert(ccc.hashCkb(tx.outputsData[codeIndex]) === dataHash, "binary data hash changed");

  const codeCell = ccc.CellAny.from({
    cellOutput: tx.outputs[codeIndex],
    outputData: tx.outputsData[codeIndex],
  });
  const minimumCodeCapacity = ccc.fixedPointFrom(codeCell.occupiedSize);
  assert(
    tx.outputs[codeIndex].capacity >=
      minimumCodeCapacity +
        ccc.fixedPointFrom(CODE_CELL_RESERVE_CKB.toString()),
    "code cell upgrade reserve is missing",
  );

  const fee = await tx.getFee(client);
  return {
    tx,
    codeIndex,
    sharedIndex,
    typeIdArgs,
    typeIdScript,
    typeHash,
    compLock,
    fee,
    minimumCodeCapacity,
  };
}

function deploymentRecord({
  txHash,
  codeIndex,
  sharedIndex,
  typeIdArgs,
  typeIdScript,
  typeHash,
  address,
  timestampField,
}) {
  return {
    network: "testnet",
    rpcUrl: RPC_URL,
    codeHash: typeHash,
    hashType: "type",
    dataHash,
    binarySha256,
    binaryBytes: binary.length,
    typeId: {
      args: typeIdArgs,
      script: {
        codeHash: typeIdScript.codeHash,
        hashType: typeIdScript.hashType,
        args: typeIdScript.args,
      },
      typeHash,
    },
    contractOutPoint: { txHash, index: indexHex(codeIndex) },
    sharedCell: {
      outPoint: { txHash, index: indexHex(sharedIndex) },
      lockArgs,
      channelHash,
      maxFeeShannon: MAX_FEE.toString(),
      capacityCkb: SHARED_CELL_CKB.toString(),
    },
    codeCellReserveCkb: CODE_CELL_RESERVE_CKB.toString(),
    feeRateShannonPerKb: FEE_RATE.toString(),
    deployer: address,
    ...timestampField,
  };
}

async function waitCommitted(txHash, timeoutMs = 600_000) {
  const started = Date.now();
  for (;;) {
    const response = await client.getTransaction(txHash);
    if (response?.status === "rejected") {
      throw new Error(`deployment transaction rejected: ${txHash}`);
    }
    if (response?.status === "committed" || response?.blockNumber !== undefined) {
      return response;
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`deployment confirmation timeout: ${txHash}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 6000));
  }
}

async function verifyLiveDeployment(plan, txHash) {
  const codeOutPoint = { txHash, index: plan.codeIndex };
  const sharedOutPoint = { txHash, index: plan.sharedIndex };
  const [codeCell, sharedCell] = await Promise.all([
    client.getCellLive(codeOutPoint, true),
    client.getCellLive(sharedOutPoint, true),
  ]);

  assert(codeCell, "deployed code cell is not live");
  assert(sharedCell, "deployed shared cell is not live");
  assert(codeCell.cellOutput.type?.eq(plan.typeIdScript), "live Type ID script mismatch");
  assert(ccc.hashCkb(codeCell.outputData) === dataHash, "live code data hash mismatch");
  assert(sharedCell.cellOutput.lock.eq(plan.compLock), "live shared lock mismatch");
  assert(ccc.hexFrom(sharedCell.outputData) === ccc.hexFrom(sharedData), "live shared data mismatch");

  return {
    checkedAt: new Date().toISOString(),
    txHash,
    transactionStatus: "committed",
    codeCell: {
      outPoint: { txHash, index: indexHex(plan.codeIndex) },
      live: true,
      dataHash,
      typeHash: plan.typeHash,
    },
    sharedCell: {
      outPoint: { txHash, index: indexHex(plan.sharedIndex) },
      live: true,
      codeHash: plan.compLock.codeHash,
      hashType: plan.compLock.hashType,
      lockArgs: plan.compLock.args,
    },
  };
}

const { signer, address, canSign } = await createSigner();
const deployerLock = (await signer.getRecommendedAddressObj()).script;
const balance = await signer.getBalance();
console.log("network: testnet");
console.log("deployer:", address);
console.log("spendable balance:", ccc.fixedPointToString(balance), "CKB");
console.log("binary sha256:", binarySha256);
console.log("binary data hash:", dataHash);

let plan;
if (SEND_PREPARED) {
  assert(canSign, "COMP_DEPLOY_KEY is required with --send-prepared");
  assert(existsSync(PREPARED_URL), "prepared transaction artifact is missing");
  const prepared = JSON.parse(readFileSync(PREPARED_URL, "utf8"));
  assert(prepared.deployer === address, "prepared deployer does not match signing key");
  assert(prepared.binarySha256 === binarySha256, "prepared binary sha256 changed");
  const tx = ccc.Transaction.from(prepared.transaction);
  const codeIndex = prepared.codeIndex;
  const sharedIndex = prepared.sharedIndex;
  const typeIdScript = tx.outputs[codeIndex].type;
  assert(typeIdScript, "prepared code cell Type ID is missing");
  const typeHash = typeIdScript.hash();
  plan = {
    tx,
    codeIndex,
    sharedIndex,
    typeIdArgs: typeIdScript.args,
    typeIdScript,
    typeHash,
    compLock: tx.outputs[sharedIndex].lock,
    fee: await tx.getFee(client),
    minimumCodeCapacity: ccc.fixedPointFrom(
      ccc.CellAny.from({
        cellOutput: tx.outputs[codeIndex],
        outputData: tx.outputsData[codeIndex],
      }).occupiedSize,
    ),
  };
  assert(plan.tx.hash() === prepared.txHash, "prepared raw transaction hash changed");
  assert(
    ccc.hashTypeId(plan.tx.inputs[0], codeIndex) === plan.typeIdArgs,
    "prepared Type ID derivation mismatch",
  );
  assert(typeIdScript.codeHash === TYPE_ID_CODE_HASH, "prepared Type ID code hash changed");
  assert(typeIdScript.hashType === "type", "prepared Type ID hash_type changed");
  assert(plan.typeHash === prepared.typeHash, "prepared type hash changed");
  assert(ccc.hashCkb(tx.outputsData[codeIndex]) === dataHash, "prepared binary changed");
  assert(plan.compLock.codeHash === plan.typeHash, "prepared COMP code_hash changed");
  assert(plan.compLock.hashType === "type", "prepared COMP hash_type changed");
  assert(plan.compLock.args === lockArgs, "prepared COMP lock args changed");
  assert(
    ccc.hexFrom(tx.outputsData[sharedIndex]) === ccc.hexFrom(sharedData),
    "prepared shared data changed",
  );
} else {
  plan = await buildTransaction(signer, deployerLock);
}

const rawTxHash = plan.tx.hash();
console.log("type id args:", plan.typeIdArgs);
console.log("type hash / COMP code_hash:", plan.typeHash);
console.log("COMP hash_type: type");
console.log("raw transaction hash:", rawTxHash);
console.log("fee:", plan.fee.toString(), "shannon");

if (!canSign) {
  const preparedAt = new Date().toISOString();
  const preparedArtifact = {
    kind: "ckb-type-id-deployment-transaction",
    network: "testnet",
    rpcUrl: RPC_URL,
    status: "prepared-for-signing",
    deployer: address,
    binarySha256,
    dataHash,
    txHash: rawTxHash,
    codeIndex: plan.codeIndex,
    sharedIndex: plan.sharedIndex,
    typeIdArgs: plan.typeIdArgs,
    typeHash: plan.typeHash,
    feeShannon: plan.fee.toString(),
    transaction: JSON.parse(plan.tx.stringify()),
    preparedAt,
  };
  writeJson(PREPARED_URL, preparedArtifact);
  writeJson(
    PREPARED_DEPLOYMENT_URL,
    deploymentRecord({
      txHash: rawTxHash,
      ...plan,
      address,
      timestampField: { preparedAt },
    }),
  );
  console.log("prepared transaction:", PREPARED_URL.pathname);
  console.log(
    "broadcast command: COMP_DEPLOY_KEY=<private-key> node deploy.mjs --send-prepared",
  );
  process.exit(0);
}

const signedTx = await signer.signTransaction(plan.tx);
assert(signedTx.hash() === rawTxHash, "signing changed the raw transaction hash");
const txHash = await client.sendTransaction(signedTx);
assert(txHash === rawTxHash, "RPC returned an unexpected transaction hash");
console.log("deployment transaction sent:", txHash);
const confirmation = await waitCommitted(txHash);
console.log("deployment transaction committed:", txHash);

const networkVerification = await verifyLiveDeployment(plan, txHash);
networkVerification.blockHash = confirmation?.blockHash;
networkVerification.blockNumber = confirmation?.blockNumber?.toString();
writeJson(NETWORK_VERIFICATION_URL, networkVerification);

if (existsSync(DEPLOYMENT_URL)) {
  writeFileSync(DEPLOYMENT_BACKUP_URL, readFileSync(DEPLOYMENT_URL));
}
const deployment = deploymentRecord({
  txHash,
  ...plan,
  address,
  timestampField: { deployedAt: new Date().toISOString() },
});
writeJson(DEPLOYMENT_URL, deployment);
console.log("deployment record:", DEPLOYMENT_URL.pathname);
console.log("network verification:", NETWORK_VERIFICATION_URL.pathname);
