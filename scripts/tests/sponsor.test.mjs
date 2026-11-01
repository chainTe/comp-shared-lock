import assert from "node:assert/strict"
import test from "node:test"
import { encodeMetadata, parseMetadata, isImmutableTransition } from "../lib/sponsor.mjs"

test("binary metadata round-trips name, kind and sponsor", () => {
  const bytes = encodeMetadata({ name: "小鲸", kind: "chat", sponsor: "鱼铺" })
  const parsed = parseMetadata(bytes)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.version, 2)
  assert.equal(parsed.name, "小鲸")
  assert.equal(parsed.kind, "chat")
  assert.equal(parsed.sponsor, "鱼铺")
})

test("sponsor is optional", () => {
  const parsed = parseMetadata(encodeMetadata({ name: "小鲸", kind: "wall" }))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.sponsor, null)
  assert.equal(parsed.kind, "wall")
})

test("legacy JSON metadata still parses", () => {
  const legacy = Buffer.from(JSON.stringify({ protocol: "comp", version: 1, type: "channel", name: "旧频道", kind: "chat", sponsor: { name: "老赞助" } }))
  const parsed = parseMetadata(legacy)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.version, 1)
  assert.equal(parsed.sponsor, "老赞助")
})

test("rejects malformed and non-comp data", () => {
  assert.equal(parseMetadata(Buffer.from("not json")).ok, false)
  assert.equal(parseMetadata(Buffer.from(JSON.stringify({ hello: 1 }))).ok, false)
  const truncated = encodeMetadata({ name: "小鲸", kind: "chat" }).subarray(0, 5)
  assert.equal(parseMetadata(truncated).ok, false)
})

test("identical data is immutable, one byte change is not", () => {
  const a = encodeMetadata({ name: "小鲸", kind: "chat", sponsor: "鱼铺" })
  assert.equal(isImmutableTransition(a, Buffer.from(a)), true)
  const b = Buffer.from(a)
  b[b.length - 1] ^= 0x01
  assert.equal(isImmutableTransition(a, b), false)
  assert.equal(isImmutableTransition(a, Buffer.concat([a, Buffer.from([0])])), false)
})
