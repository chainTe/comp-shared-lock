/**
 * 频道元数据的紧凑二进制格式（comp-meta v2）。
 * 布局：
 *   [0]     版本 0x02
 *   [1]     flags（bit0 = 带赞助商）
 *   [2..4]  name_len (u16 LE)
 *   [4..]   name（UTF-8）
 *   [..]    kind（u8：0=chat, 1=wall）
 *   [..]    sponsor_len（u8，0 = 没有）+ sponsor（UTF-8）
 * 解析先认 0x02，不认就退回旧版 JSON，老频道照样能读。
 */
export const KIND = { chat: 0, wall: 1 }
export const KIND_NAME = ["chat", "wall"]
export const VERSION = 0x02

export function encodeMetadata({ name, kind = "chat", sponsor = null }) {
  const nameBuf = Buffer.from(String(name), "utf8")
  const sponsorBuf = sponsor ? Buffer.from(String(sponsor), "utf8") : Buffer.alloc(0)
  if (nameBuf.length > 0xffff) throw new Error("name 太长")
  if (sponsorBuf.length > 0xff) throw new Error("sponsor 太长")
  const kindByte = KIND[kind]
  if (kindByte === undefined) throw new Error(`未知 kind: ${kind}`)
  const head = Buffer.alloc(4)
  head[0] = VERSION
  head[1] = sponsorBuf.length ? 1 : 0
  head.writeUInt16LE(nameBuf.length, 2)
  return Buffer.concat([head, nameBuf, Buffer.from([kindByte, sponsorBuf.length]), sponsorBuf])
}

export function parseMetadata(cellData) {
  const bytes = Buffer.isBuffer(cellData) ? cellData : Buffer.from(String(cellData).replace(/^0x/, ""), "hex")
  if (bytes.length && bytes[0] === VERSION) {
    if (bytes.length < 6) return { ok: false, reason: "data 太短" }
    const flags = bytes[1]
    const nameLen = bytes.readUInt16LE(2)
    let off = 4
    if (bytes.length < off + nameLen + 2) return { ok: false, reason: "name 越界" }
    const name = bytes.subarray(off, off + nameLen).toString("utf8")
    off += nameLen
    const kind = KIND_NAME[bytes[off]]
    off += 1
    const sponsorLen = bytes[off]
    off += 1
    if (bytes.length < off + sponsorLen) return { ok: false, reason: "sponsor 越界" }
    if (off + sponsorLen !== bytes.length) return { ok: false, reason: "尾部有多余字节" }
    const sponsor = sponsorLen ? bytes.subarray(off, off + sponsorLen).toString("utf8") : null
    if ((flags & 1) && !sponsor) return { ok: false, reason: "flags 说有赞助商但字段为空" }
    return { ok: true, version: 2, name, kind, sponsor }
  }
  try {
    const meta = JSON.parse(bytes.toString("utf8"))
    if (!meta || meta.protocol !== "comp") return { ok: false, reason: "不是 comp 元数据" }
    return { ok: true, version: 1, name: meta.name, kind: meta.kind, sponsor: meta.sponsor?.name ?? null }
  } catch {
    return { ok: false, reason: "既不是 v2 二进制，也不是旧版 JSON" }
  }
}

/** v0.4 的不可变规则：后继 data 必须与输入逐字节一致。 */
export function isImmutableTransition(inputData, outputData) {
  const norm = (v) => Buffer.from(v instanceof Uint8Array ? v : String(v).replace(/^0x/, ""), "hex")
  const a = norm(inputData)
  const b = norm(outputData)
  return a.length === b.length && a.equals(b)
}
