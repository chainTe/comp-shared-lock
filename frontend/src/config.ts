import { ccc } from "@ckb-ccc/shell";
import type { DeploymentConfig } from "./types";

export let deployment: DeploymentConfig | undefined;

export async function loadDeployment(): Promise<DeploymentConfig> {
  if (deployment) return deployment;

  const baseUrl = import.meta.env.BASE_URL;
  const sources = [`${baseUrl}deployment.local.json`, `${baseUrl}deployment.json`];
  let lastError: unknown;

  for (const path of sources) {
    try {
      const res = await fetch(path);
      if (!res.ok) continue;
      const data = (await res.json()) as DeploymentConfig;
      deployment = data;
      return data;
    } catch (e) {
      lastError = e;
    }
  }

  throw new Error(
    `failed to load deployment.json: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export function compLockTemplate(cfg: DeploymentConfig): ccc.Script {
  return ccc.Script.from({
    codeHash: cfg.codeHash,
    hashType: cfg.hashType,
    args: "0x",
  });
}

export function compLockForChannel(cfg: DeploymentConfig, channelHash: string): ccc.Script {
  return ccc.Script.from({
    codeHash: cfg.codeHash,
    hashType: cfg.hashType,
    args: channelHash,
  });
}

export function buildCompArgs(channelHash: string, maxFee: bigint): string {
  const hashBytes = ccc.bytesFrom(channelHash);
  if (hashBytes.length !== 32) {
    throw new Error("channel hash must be 32 bytes");
  }
  const feeBytes = new Uint8Array(8);
  const view = new DataView(feeBytes.buffer);
  view.setBigUint64(0, maxFee, true);
  return ccc.hexFrom(ccc.bytesConcat(hashBytes, feeBytes));
}

export function parseCompArgs(args: string): { channelHash: string; maxFee: bigint } {
  const bytes = ccc.bytesFrom(args);
  if (bytes.length !== 40) {
    throw new Error(`COMP lock args must be 40 bytes, got ${bytes.length}`);
  }
  const channelHash = ccc.hexFrom(bytes.slice(0, 32));
  const view = new DataView(bytes.buffer, bytes.byteOffset + 32, 8);
  const maxFee = view.getBigUint64(0, true);
  return { channelHash, maxFee };
}
