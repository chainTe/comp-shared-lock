/**
 * 赞助署名：把频道元数据哈希进 channel_hash，并用 args 里 max_fee 的最高位
 * 作为「署名模式」开关。
 *   flag = 0 → 老规则（v0.3），不校验 data
 *   flag = 1 → 强制 blake2b_256(canonical_json(data)) == channel_hash
 */
import { blake2b } from "@noble/hashes/blake2.js"

export const ATTEST_FLAG = 1n << 63n
export const MAX_FEE_MASK = ATTEST_FLAG - 1n

/** 稳定的 JSON：键排序、无空格，保证同样的数据算出同样的哈希。 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

/** channel_hash = blake2b_256(canonical_json(metadata))，返回 0x 开头的 32 字节。 */
export function metadataHash(metadata) {
  const digest = blake2b(new TextEncoder().encode(canonicalJson(metadata)), { dkLen: 32 })
  return "0x" + Buffer.from(digest).toString("hex")
}

/** 拆 args：channel_hash(32) || max_fee(8, LE)，max_fee 最高位是署名模式开关。 */
export function parseArgs(lockArgs) {
  const hex = String(lockArgs).replace(/^0x/, "")
  if (hex.length !== 80) throw new Error("args 必须是 40 字节")
  const channelHash = "0x" + hex.slice(0, 64).toLowerCase()
  let maxFee = 0n
  for (let i = 7; i >= 0; i -= 1) maxFee = (maxFee << 8n) | BigInt(parseInt(hex.slice(64 + i * 2, 66 + i * 2), 16))
  const attested = (maxFee & ATTEST_FLAG) !== 0n
  return { channelHash, maxFee: maxFee & MAX_FEE_MASK, attested }
}

/** 校验元数据：只有署名模式才要求哈希一致；老规则返回 legacy。 */
export function verifyMetadata(lockArgs, metadata) {
  const { channelHash, attested } = parseArgs(lockArgs)
  if (!attested) return { ok: true, legacy: true, hash: channelHash }
  const computed = metadataHash(metadata)
  return computed === channelHash
    ? { ok: true, attested: true, hash: computed }
    : { ok: false, reason: "元数据与 channel_hash 不匹配（可能被改过）", expected: computed, onChain: channelHash }
}
