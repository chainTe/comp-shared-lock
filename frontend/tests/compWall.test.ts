import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_EVENTS_PER_POST,
  WALL_HEIGHT,
  WALL_WIDTH,
  eventBounds,
  mergeGraffitiRecords,
  parseGraffitiPayload,
  recordsFromMessages,
  reconcileConfirmedHistory,
  serializeGraffitiBatch,
  simplifyPoints,
  type GraffitiEvent,
  type GraffitiRecord,
} from "../src/compWall.ts";
import type { Message } from "../src/types.ts";
import {
  channelHashFromName,
  channelKind,
  channelMetadata,
  channelRoute,
  encodeChannelMetadata,
  parseChannelMetadata,
} from "../src/channelNames.ts";

const fixtures: GraffitiEvent[] = [
  { type: "stroke", points: [[1, 2], [3, 4], [8, 9]], color: "#7861FF", width: 8 },
  { type: "erase", points: [[10, 20], [30, 40]], width: 24 },
  { type: "text", x: 320, y: 180, text: "GM CKB!", color: "#111111", size: 32 },
  { type: "shape", shape: "circle", x: 300, y: 200, radius: 50, color: "#FFB020", width: 6 },
  { type: "shape", shape: "rectangle", x: 20, y: 30, rectWidth: 80, rectHeight: 60, color: "#20A46B", width: 5 },
  { type: "shape", shape: "line", x1: 1, y1: 2, x2: 100, y2: 200, color: "#2387FF", width: 4 },
  { type: "shape", shape: "arrow", x1: 10, y1: 20, x2: 180, y2: 220, color: "#F05A3C", width: 7 },
];

const GENERAL_CHANNEL_HASH = "0x3bf471b16283375362945f60972e6dd4a998db34b53623457dcaa800b6a42726";

test("legacy General resolves to the text-room route", () => {
  assert.equal(channelKind(GENERAL_CHANNEL_HASH), "chat");
  assert.equal(channelRoute(GENERAL_CHANNEL_HASH, "chat"), `#/channel/${GENERAL_CHANNEL_HASH}`);
});

test("channel metadata preserves chat/wall presentation without changing the deterministic hash", () => {
  const chatData = encodeChannelMetadata("Community", "chat");
  const wallData = encodeChannelMetadata("Community", "wall");
  assert.deepEqual(parseChannelMetadata(chatData), channelMetadata("Community", "chat"));
  assert.deepEqual(parseChannelMetadata(wallData), channelMetadata("Community", "wall"));
  const hash = channelHashFromName("Community");
  assert.equal(channelKind(hash, [chatData]), "chat");
  assert.equal(channelKind(hash, [wallData]), "wall");
});

test("all MVP event types round-trip through the comp-wall v1 batch codec", () => {
  const payload = serializeGraffitiBatch(fixtures);
  const decoded = parseGraffitiPayload(payload);
  assert.deepEqual(decoded?.events, fixtures);
  assert.deepEqual(decoded?.canvas, [WALL_WIDTH, WALL_HEIGHT]);
  assert.equal(decoded?.type, "batch");
});

test("codec accepts the early single-event fixture and normalizes it to a batch", () => {
  const payload = JSON.stringify({ version: 1, ...fixtures[0] });
  assert.deepEqual(parseGraffitiPayload(payload)?.events, [fixtures[0]]);
});

test("invalid and oversized semantic inputs are rejected", () => {
  assert.equal(parseGraffitiPayload("not json"), undefined);
  assert.equal(parseGraffitiPayload(JSON.stringify({
    protocol: "comp-wall",
    version: 1,
    type: "batch",
    canvas: [WALL_WIDTH, WALL_HEIGHT],
    events: [{ type: "text", x: -1, y: 2, text: "bad", color: "#111111", size: 20 }],
  })), undefined);
  assert.throws(
    () => serializeGraffitiBatch(Array.from({ length: MAX_EVENTS_PER_POST + 1 }, () => fixtures[0])),
    /at most/,
  );
});

test("message decoding assigns stable event ids and chronological chain order", () => {
  const older: Message = {
    txHash: "0xbbb",
    status: "confirmed",
    blockNumber: 8n,
    transactionIndex: 2,
    compInputIndex: 0,
    author: "Anonymous",
    payload: serializeGraffitiBatch([fixtures[0]]),
  };
  const newer: Message = {
    txHash: "0xaaa",
    status: "confirmed",
    blockNumber: 9n,
    transactionIndex: 0,
    compInputIndex: 1,
    author: "0x02signed",
    payload: serializeGraffitiBatch([fixtures[2], fixtures[3]]),
  };
  const records = recordsFromMessages([newer, older]);
  assert.deepEqual(records.map((record) => record.eventId), [
    "0xbbb:0:0",
    "0xaaa:1:0",
    "0xaaa:1:1",
  ]);
  assert.equal(records[2].signed, true);
});

test("confirmed records replace pending overlays with the same event id", () => {
  const base: GraffitiRecord = {
    eventId: "0xtx:0:0",
    txHash: "0xtx",
    eventIndex: 0,
    event: fixtures[0],
    status: "pending",
    author: "Anonymous",
    signed: false,
    seenAt: 100,
  };
  const merged = mergeGraffitiRecords([base], [{ ...base, status: "confirmed", blockNumber: 10n }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "confirmed");
});

test("fresh scan reconciliation drops reorg-orphaned records but keeps older cached history", () => {
  const record = (eventId: string, blockNumber: bigint): GraffitiRecord => ({
    eventId,
    txHash: eventId,
    eventIndex: 0,
    event: fixtures[0],
    status: "confirmed",
    author: "Anonymous",
    signed: false,
    blockNumber,
    seenAt: 1,
  });
  const old = record("0xold", 7n);
  const orphaned = record("0xorphan", 9n);
  const fresh = record("0xfresh", 10n);
  const scanned: Message[] = [
    { txHash: "0xwindow", status: "confirmed", blockNumber: 8n, author: "Anonymous", payload: "plain COMP text" },
    { txHash: "0xfresh", status: "confirmed", blockNumber: 10n, author: "Anonymous", payload: serializeGraffitiBatch([fixtures[0]]) },
  ];
  assert.deepEqual(
    reconcileConfirmedHistory([old, orphaned], [fresh], scanned).map((item) => item.eventId),
    ["0xold", "0xfresh"],
  );
});

test("stroke simplification preserves endpoints and event bounds remain inside the wall", () => {
  const simplified = simplifyPoints([[0, 0], [5, .1], [10, 0]], 1.5);
  assert.deepEqual(simplified, [[0, 0], [10, 0]]);
  const bounds = eventBounds({ type: "stroke", points: [[0, 0], [WALL_WIDTH, WALL_HEIGHT]], color: "#111111", width: 20 });
  assert.deepEqual(bounds, { minX: 0, minY: 0, maxX: WALL_WIDTH, maxY: WALL_HEIGHT });
});
