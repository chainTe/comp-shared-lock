/**
 * comp-wall v2 二进制 payload。
 *
 * JSON 版一次涂鸦动辄几 KB；二进制把坐标压成 u16 + 增量 varint，
 * 颜色压成 3 字节 RGB，通常能小一个数量级。
 *
 * 布局：
 *   "CW" (2B) | version 0x02 (1B) | canvasW u16 | canvasH u16 | count u8
 *   event:
 *     type u8: 1=stroke 2=erase 3=text 4=circle 5=rect 6=line 7=arrow
 *     stroke/erase: [rgb 3B] width u8 count u16 points...
 *     points: 首点 x u16,y u16；之后 dx,dy 用 zigzag varint
 *     text: rgb 3B | x u16 | y u16 | size u8 | len u16 | utf8
 *     circle: rgb 3B | width u8 | x u16 | y u16 | r u16
 *     rect:   rgb 3B | width u8 | x u16 | y u16 | w u16 | h u16
 *     line/arrow: rgb 3B | width u8 | x1 u16 | y1 u16 | x2 u16 | y2 u16
 */
export const WALL_MAGIC = [0x43, 0x57]
export const WALL_VERSION = 0x02
export const WALL_WIDTH = 1920
export const WALL_HEIGHT = 1080
export const TYPES = { stroke: 1, erase: 2, text: 3, circle: 4, rect: 5, line: 6, arrow: 7 }
export const SHAPES = { circle: 4, rect: 5, line: 6, arrow: 7 }

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16))
const rgbToHex = (buf, off) => "#" + [0, 1, 2].map((i) => buf[off + i].toString(16).padStart(2, "0")).join("")

function zigzag(n) {
  return n >= 0 ? n << 1 : ((-n << 1) - 1) >>> 0
}
function unzigzag(n) {
  return n & 1 ? -((n + 1) >>> 1) : n >>> 1
}
function pushVarint(out, value) {
  let v = Number(value)
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v)
}
function readVarint(buf, state) {
  let shift = 0
  let result = 0
  for (;;) {
    const byte = buf[state.off++]
    if (byte === undefined) throw new Error("varint 越界")
    result += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return result
    shift += 7
  }
}
const u16 = (n) => [n & 0xff, (n >> 8) & 0xff]

export function encodeWall(events, { canvas = [WALL_WIDTH, WALL_HEIGHT] } = {}) {
  const out = [...WALL_MAGIC, WALL_VERSION, ...u16(canvas[0]), ...u16(canvas[1]), events.length & 0xff]
  for (const event of events) {
    out.push(event.type === "shape" ? SHAPES[event.shape] : TYPES[event.type])
    const color = event.color ? hexToRgb(event.color) : [0, 0, 0]
    if (event.type === "stroke" || event.type === "erase") {
      out.push(...color, event.width & 0xff, ...u16(event.points.length))
      let px = 0
      let py = 0
      event.points.forEach(([x, y], i) => {
        const ix = Math.round(x)
        const iy = Math.round(y)
        if (i === 0) out.push(...u16(ix), ...u16(iy))
        else {
          pushVarint(out, zigzag(ix - px))
          pushVarint(out, zigzag(iy - py))
        }
        px = ix
        py = iy
      })
    } else if (event.type === "text") {
      const utf8 = Buffer.from(event.text, "utf8")
      out.push(...color, ...u16(Math.round(event.x)), ...u16(Math.round(event.y)), event.size & 0xff, ...u16(utf8.length), ...utf8)
    } else if (event.type === "shape") {
      out.push(...color, event.width & 0xff, ...u16(Math.round(event.x)), ...u16(Math.round(event.y)))
      if (event.shape === "circle") out.push(...u16(Math.round(event.radius)))
      else if (event.shape === "rectangle") out.push(...u16(Math.round(event.rectWidth)), ...u16(Math.round(event.rectHeight)))
      else out.push(...u16(Math.round(event.x2)), ...u16(Math.round(event.y2)))
    } else {
      throw new Error(`未知事件类型：${event.type}`)
    }
  }
  return Buffer.from(out)
}

export function decodeWall(buf) {
  if (buf[0] !== WALL_MAGIC[0] || buf[1] !== WALL_MAGIC[1]) throw new Error("不是 comp-wall 二进制")
  if (buf[2] !== WALL_VERSION) throw new Error(`不支持的版本：${buf[2]}`)
  const canvas = [buf.readUInt16LE(3), buf.readUInt16LE(5)]
  const count = buf[7]
  const state = { off: 8 }
  const events = []
  const readU16 = () => {
    const v = buf.readUInt16LE(state.off)
    state.off += 2
    return v
  }
  for (let i = 0; i < count; i += 1) {
    const type = buf[state.off++]
    const color = rgbToHex(buf, state.off)
    state.off += 3
    if (type === 1 || type === 2) {
      const width = buf[state.off++]
      const n = readU16()
      const points = []
      let px = 0
      let py = 0
      for (let k = 0; k < n; k += 1) {
        if (k === 0) { px = readU16(); py = readU16() }
        else { px += unzigzag(readVarint(buf, state)); py += unzigzag(readVarint(buf, state)) }
        points.push([px, py])
      }
      events.push(type === 1 ? { type: "stroke", points, color, width } : { type: "erase", points, width })
    } else if (type === 3) {
      const x = readU16()
      const y = readU16()
      const size = buf[state.off++]
      const len = readU16()
      const text = buf.subarray(state.off, state.off + len).toString("utf8")
      state.off += len
      events.push({ type: "text", x, y, text, color, size })
    } else if (type >= 4 && type <= 7) {
      const shape = ["circle", "rectangle", "line", "arrow"][type - 4]
      const width = buf[state.off++]
      const x = readU16()
      const y = readU16()
      const base = { type: "shape", shape, color, width, x, y }
      if (shape === "circle") events.push({ ...base, radius: readU16() })
      else if (shape === "rectangle") events.push({ ...base, rectWidth: readU16(), rectHeight: readU16() })
      else events.push({ ...base, x2: readU16(), y2: readU16() })
    } else throw new Error(`未知类型码：${type}`)
  }
  return { protocol: "comp-wall", version: 2, canvas, events }
}
