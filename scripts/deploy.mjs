import { ccc } from "@ckb-ccc/shell";
import { readFileSync, writeFileSync } from "fs";

const PRIVATE_KEY = process.env.COMP_DEPLOY_KEY;
if (!PRIVATE_KEY) {
  console.error("set COMP_DEPLOY_KEY env var (testnet private key)");
  process.exit(1);
}

const client = new ccc.ClientPublicTestnet();
const signer = new ccc.SignerCkbPrivateKey(client, PRIVATE_KEY);
const address = await signer.getRecommendedAddress();
console.log("deployer:", address);

const balance = await signer.getBalance();
console.log("balance:", ccc.fixedPointToString(balance), "CKB");

const binary = readFileSync(new URL("../build/release/comp-shared-lock", import.meta.url));
const codeHash = ccc.hashCkb(binary);
console.log("contract code_hash (data2):", ccc.hexFrom(codeHash));

// 1. deploy the contract binary cell
const deployTx = ccc.Transaction.from({
  outputs: [
    {
      lock: (await signer.getRecommendedAddressObj()).script,
      capacity: ccc.fixedPointFrom((binary.length + 8) + 5000), // data bytes + header + margin
    },
  ],
  outputsData: [ccc.bytesFrom(binary)],
});
await deployTx.completeInputsByCapacity(signer);
await deployTx.completeFeeBy(signer, 1000);
const deployTxHash = await signer.sendTransaction(deployTx);
console.log("deploy tx:", deployTxHash);

// 2. create the first COMP shared cell (channel "general", max_fee = 0.01 CKB)
const MAX_FEE = 1_000_000n; // shannon
const channelHash = ccc.hashCkb(ccc.bytesFrom("comp-channel-general", "utf8"));
const maxFeeBytes = new Uint8Array(8);
new DataView(maxFeeBytes.buffer).setBigUint64(0, MAX_FEE, true);
const lockArgs = ccc.bytesFrom(ccc.bytesConcat(channelHash, maxFeeBytes));

const compLock = ccc.Script.from({
  codeHash,
  hashType: "data2",
  args: ccc.hexFrom(lockArgs),
});

// wait until deploy tx is committed so the cell dep is live
const waitCommitted = async (txHash) => {
  for (;;) {
    const tx = await client.getTransaction(txHash);
    if (tx && tx.status === "committed") return;
    if (tx && tx.status === "rejected") throw new Error("tx rejected");
    await new Promise((r) => setTimeout(r, 6000));
    process.stdout.write(".");
  }
};
console.log("waiting for deploy tx to be committed");
await waitCommitted(deployTxHash);

const createTx = ccc.Transaction.from({
  cellDeps: [{ outPoint: { txHash: deployTxHash, index: 0 }, depType: "code" }],
  outputs: [
    {
      lock: compLock,
      capacity: ccc.fixedPointFrom(200), // 200 CKB community pool
    },
  ],
  outputsData: [ccc.bytesFrom("COMP shared cell #0", "utf8")],
});
await createTx.completeInputsByCapacity(signer);
await createTx.completeFeeBy(signer, 1000);
const createTxHash = await signer.sendTransaction(createTx);
console.log("shared cell creation tx:", createTxHash);
await waitCommitted(createTxHash);

const deployment = {
  network: "testnet",
  codeHash: ccc.hexFrom(codeHash),
  hashType: "data2",
  contractOutPoint: { txHash: deployTxHash, index: "0x0" },
  sharedCell: {
    outPoint: { txHash: createTxHash, index: "0x0" },
    lockArgs: ccc.hexFrom(lockArgs),
    channelHash: ccc.hexFrom(channelHash),
    maxFeeShannon: MAX_FEE.toString(),
  },
  deployer: address,
  deployedAt: new Date().toISOString(),
};
writeFileSync(new URL("../deployment.json", import.meta.url), JSON.stringify(deployment, null, 2));
console.log("deployment.json written");
