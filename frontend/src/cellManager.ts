import { ccc } from "@ckb-ccc/shell";
import { client, MESSAGE_FEE_RATE } from "./rpc";
import { buildCompArgs, loadDeployment } from "./config";
import { channelHashFromName, encodeChannelMetadata } from "./channelNames";

// 8-byte capacity + 33-byte script header + 40-byte COMP lock args.
const COMP_CELL_OUTPUT_BYTES = 81;
export const MAX_INITIAL_CELL_COUNT = 100;

export function minimumCompCellCapacity(outputData = "0x"): bigint {
  return ccc.fixedPointFrom(COMP_CELL_OUTPUT_BYTES + ccc.bytesFrom(outputData).length);
}

export function normalizeCellCount(cellCount: string | number): number {
  const value = String(cellCount).trim();
  if (!/^\d+$/.test(value)) {
    throw new Error("cell count must be a whole number");
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_INITIAL_CELL_COUNT) {
    throw new Error(`cell count must be between 1 and ${MAX_INITIAL_CELL_COUNT}`);
  }
  return count;
}

export function buildCompCellOutputs(
  lock: ccc.Script,
  capacity: bigint,
  cellCount: string | number,
  firstOutputData = "0x",
) {
  const count = normalizeCellCount(cellCount);
  return {
    outputs: Array.from({ length: count }, () => ({ lock, capacity })),
    // One metadata-bearing Cell is sufficient for channel discovery. Every
    // transition preserves that Cell's data, while the remaining Cells stay
    // at their smallest occupied capacity.
    outputsData: Array.from(
      { length: count },
      (_, index) => index === 0 ? firstOutputData : "0x",
    ),
  };
}

export async function addCellWithSigner(
  signer: ccc.Signer,
  channelHash: string,
  capacityCkb: string | number,
  maxFeeCkb: string | number,
  outputData = "0x",
): Promise<string> {
  return addCellsWithSigner(
    signer,
    channelHash,
    capacityCkb,
    maxFeeCkb,
    1,
    outputData,
  );
}

export async function addCellsWithSigner(
  signer: ccc.Signer,
  channelHash: string,
  capacityCkb: string | number,
  maxFeeCkb: string | number,
  cellCount: string | number,
  firstOutputData = "0x",
): Promise<string> {
  const cfg = await loadDeployment();
  const capacity = ccc.fixedPointFrom(String(capacityCkb));
  const maxFee = ccc.fixedPointFrom(String(maxFeeCkb));
  const count = normalizeCellCount(cellCount);

  if (maxFee <= 0n) {
    throw new Error("max fee must be greater than 0 CKB");
  }
  const minimumCapacity = minimumCompCellCapacity(firstOutputData);
  if (capacity < minimumCapacity) {
    throw new Error(
      `capacity must be at least ${ccc.fixedPointToString(minimumCapacity)} CKB for this Cell`,
    );
  }

  const args = buildCompArgs(channelHash, maxFee);
  const lock = ccc.Script.from({
    codeHash: cfg.codeHash,
    hashType: cfg.hashType,
    args,
  });
  const { outputs, outputsData } = buildCompCellOutputs(
    lock,
    capacity,
    count,
    firstOutputData,
  );

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
    outputs,
    outputsData,
  });

  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, MESSAGE_FEE_RATE);
  const txHash = await signer.sendTransaction(tx);
  return txHash;
}

export async function createChannelWithSigner(
  signer: ccc.Signer,
  name: string,
  capacityCkb: string | number,
  maxFeeCkb: string | number,
  cellCount: string | number = 1,
): Promise<{ txHash: string; channelHash: string; outputData: string; cellCount: number }> {
  const channelHash = channelHashFromName(name);
  const outputData = encodeChannelMetadata(name);
  const count = normalizeCellCount(cellCount);
  const txHash = await addCellsWithSigner(
    signer,
    channelHash,
    capacityCkb,
    maxFeeCkb,
    count,
    outputData,
  );
  return { txHash, channelHash, outputData, cellCount: count };
}
