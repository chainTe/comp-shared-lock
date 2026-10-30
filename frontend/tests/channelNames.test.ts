import assert from "node:assert/strict";
import test from "node:test";
import {
  channelHashFor,
  channelHashFromName,
  channelHashMatches,
  channelMetadata,
  encodeChannelMetadata,
  parseChannelMetadata,
} from "../src/channelNames.ts";

test("kind is part of the new channel hash", () => {
  const chat = channelHashFor("小鲸", "chat");
  const wall = channelHashFor("小鲸", "wall");
  assert.notEqual(chat, wall);
});

test("legacy name-only hash still matches for both kinds", () => {
  const legacy = channelHashFromName("小鲸");
  assert.equal(channelHashMatches(legacy, "小鲸"), true);
  assert.equal(channelHashMatches(legacy, "小鲸", "chat"), true);
  assert.equal(channelHashMatches(legacy, "小鲸", "wall"), true);
});

test("kind-scoped hash matches only its own kind", () => {
  const wall = channelHashFor("小鲸", "wall");
  assert.equal(channelHashMatches(wall, "小鲸", "wall"), true);
  assert.equal(channelHashMatches(wall, "小鲸", "chat"), false);
  assert.equal(channelHashMatches(wall, "别的东西"), false);
});

test("metadata round-trips with its kind", () => {
  const data = encodeChannelMetadata("小鲸", "wall");
  const parsed = parseChannelMetadata(data);
  assert.equal(parsed?.kind, "wall");
  assert.deepEqual(parsed, channelMetadata("小鲸", "wall"));
});
