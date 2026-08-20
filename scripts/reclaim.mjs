import { ccc } from "@ckb-ccc/shell";

const PRIVATE_KEY = process.env.COMP_DEPLOY_KEY;
const OUT_POINT = process.env.RECLAIM_OUTPOINT; // "txHash:index"
if (!PRIVATE_KEY || !OUT_POINT) process.exit(1);

const client = new ccc.ClientPublicTestnet();
const signer = new ccc.SignerCkbPrivateKey(client, PRIVATE_KEY);
const [txHash, index] = OUT_POINT.split(":");

const tx = ccc.Transaction.from({
  inputs: [{ previousOutput: { txHash, index: BigInt(index) } }],
  outputs: [{ lock: (await signer.getRecommendedAddressObj()).script }],
});
await tx.completeInputsByCapacity(signer);
await tx.completeFeeBy(signer, 3600);
const hash = await signer.sendTransaction(tx);
console.log("reclaim tx:", hash);
process.exit(0);
