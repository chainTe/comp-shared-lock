/**
 * 赞助署名：每个 cell 的 data 写着自己的赞助商；合约保证 data 不可变，
 * 所以"用谁的 cell 发交易，广告就是谁的"。
 */
export function parseMetadata(cellData) {
  const bytes = cellData instanceof Uint8Array ? cellData : Buffer.from(String(cellData).replace(/^0x/, ""), "hex")
  const text = Buffer.from(bytes).toString("utf8")
  let meta
  try {
    meta = JSON.parse(text)
  } catch {
    return { ok: false, reason: "data 不是合法 JSON" }
  }
  if (!meta || meta.protocol !== "comp") return { ok: false, reason: "不是 comp 元数据" }
  const sponsor = meta.sponsor && typeof meta.sponsor.name === "string" ? meta.sponsor : null
  return { ok: true, name: meta.name, kind: meta.kind, sponsor }
}

/** v0.4 的不可变规则：后继 data 必须与输入逐字节一致。 */
export function isImmutableTransition(inputData, outputData) {
  const a = Buffer.from(inputData instanceof Uint8Array ? inputData : String(inputData).replace(/^0x/, ""), "hex")
  const b = Buffer.from(outputData instanceof Uint8Array ? outputData : String(outputData).replace(/^0x/, ""), "hex")
  return a.length === b.length && a.equals(b)
}
