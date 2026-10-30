/**
 * 赞助署名：把频道元数据（含创建者/赞助方）哈希成 channel_hash，
 * 写进 lock args。args 不可变，所以署名也就不可改；客户端用哈希校验。
 */
import { blake2b } from "@noble/hashes/blake2.js"

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

/** 校验：元数据 cell 里的内容是否与 lock args 里的 channel_hash 对得上。 */
export function verifyMetadata(lockArgs, metadata) {
  const args = String(lockArgs).replace(/^0x/, "")
  if (args.length < 64) return { ok: false, reason: "args 不足 40 字节" }
  const onChain = "0x" + args.slice(0, 64).toLowerCase()
  const computed = metadataHash(metadata)
  return computed === onChain
    ? { ok: true, hash: computed }
    : { ok: false, reason: "元数据与 channel_hash 不匹配（可能被改过）", expected: computed, onChain }
}
