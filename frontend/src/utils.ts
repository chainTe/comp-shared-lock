import { ccc } from "@ckb-ccc/shell";
import type { CompMessage } from "./types";

export function truncateHash(hash: string, start = 6, end = 4): string {
  if (hash.length <= start + end + 2) return hash;
  return `${hash.slice(0, start + 2)}…${hash.slice(-end)}`;
}

export function formatCapacity(value?: bigint): string {
  return value === undefined ? "unknown" : `${ccc.fixedPointToString(value)} CKB`;
}

export function formatCapacityDelta(value?: bigint): string {
  if (value === undefined) return "unknown";
  const sign = value > 0n ? "+" : value < 0n ? "−" : "";
  const absolute = value < 0n ? -value : value;
  return `${sign}${ccc.fixedPointToString(absolute)} CKB`;
}

export function parseCompMessage(tx: ccc.Transaction, inputIndex?: number): CompMessage | undefined {
  if (inputIndex === undefined) return;
  try {
    const lock = tx.getWitnessArgsAtUnsafe(inputIndex)?.lock;
    if (!lock) return;
    const value = JSON.parse(new TextDecoder().decode(ccc.bytesFrom(lock))) as Partial<CompMessage>;
    const ext = value.extensions;
    if (
      !ext ||
      ext.protocol !== "comp" ||
      (ext.version !== 1 && ext.version !== 2) ||
      ext.type !== "text" ||
      typeof ext.payload !== "string"
    ) {
      return;
    }
    if (
      value.public_key !== undefined &&
      value.public_key !== null &&
      typeof value.public_key !== "string"
    ) return;
    if (
      value.address !== undefined &&
      value.address !== null &&
      typeof value.address !== "string"
    ) return;
    if (
      value.signature !== undefined &&
      value.signature !== null &&
      typeof value.signature !== "string"
    ) return;
    return {
      public_key: value.public_key ?? null,
      address: value.address ?? null,
      signature: value.signature ?? null,
      extensions: ext,
    };
  } catch {
    return;
  }
}

export function extensionsJson(payload: string): string {
  return JSON.stringify({ protocol: "comp", version: 2, type: "text", payload });
}

export function anonymousWitnessJson(payload: string): string {
  return JSON.stringify({
    public_key: null,
    signature: null,
    extensions: { protocol: "comp", version: 2, type: "text", payload },
  });
}

export function signedWitnessJson(publicKey: string, signature: string, payload: string): string {
  return JSON.stringify({
    public_key: publicKey,
    signature,
    extensions: { protocol: "comp", version: 2, type: "text", payload },
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function classifiableError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}
