import type { Message } from "./types";
import { WALL_BINARY_PREFIX, decodeWallV2Payload, encodeWallV2Payload } from "./wallBinary.ts";

export const WALL_PROTOCOL = "comp-wall" as const;
export const WALL_VERSION = 1 as const;
export const WALL_BINARY_VERSION = 2 as const;
export const WALL_WIDTH = 1920;
export const WALL_HEIGHT = 1080;
export const MAX_EVENTS_PER_POST = 64;
export const MAX_POINTS_PER_STROKE = 2048;
export const MAX_TEXT_LENGTH = 280;
export const MAX_PAYLOAD_BYTES = 32 * 1024;
export const MAX_BRUSH_WIDTH = 96;

export type Point = [number, number];
export type ShapeKind = "circle" | "rectangle" | "line" | "arrow";

export interface StrokeEvent {
  type: "stroke";
  points: Point[];
  color: string;
  width: number;
}

export interface EraseEvent {
  type: "erase";
  points: Point[];
  width: number;
}

export interface TextEvent {
  type: "text";
  x: number;
  y: number;
  text: string;
  color: string;
  size: number;
}

interface ShapeStyle {
  type: "shape";
  shape: ShapeKind;
  color: string;
  width: number;
}

export interface CircleEvent extends ShapeStyle {
  shape: "circle";
  x: number;
  y: number;
  radius: number;
}

export interface RectangleEvent extends ShapeStyle {
  shape: "rectangle";
  x: number;
  y: number;
  rectWidth: number;
  rectHeight: number;
}

export interface LinearShapeEvent extends ShapeStyle {
  shape: "line" | "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type ShapeEvent = CircleEvent | RectangleEvent | LinearShapeEvent;
export type GraffitiEvent = StrokeEvent | EraseEvent | TextEvent | ShapeEvent;

export interface GraffitiBatch {
  protocol: typeof WALL_PROTOCOL;
  version: typeof WALL_VERSION | typeof WALL_BINARY_VERSION;
  type: "batch";
  canvas: [typeof WALL_WIDTH, typeof WALL_HEIGHT];
  events: GraffitiEvent[];
}

export interface GraffitiRecord {
  eventId: string;
  txHash: string;
  eventIndex: number;
  event: GraffitiEvent;
  status: "pending" | "confirmed";
  author: string;
  signed: boolean;
  blockNumber?: bigint;
  blockHash?: string;
  timestamp?: bigint;
  transactionIndex?: number;
  compInputIndex?: number;
  seenAt: number;
}

export interface EventBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function coordinate(value: unknown, max: number): value is number {
  return finiteNumber(value) && value >= 0 && value <= max;
}

function brushWidth(value: unknown): value is number {
  return finiteNumber(value) && value >= 1 && value <= MAX_BRUSH_WIDTH;
}

function color(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function points(value: unknown): Point[] | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_POINTS_PER_STROKE) return;
  const parsed: Point[] = [];
  for (const point of value) {
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      !coordinate(point[0], WALL_WIDTH) ||
      !coordinate(point[1], WALL_HEIGHT)
    ) return;
    parsed.push([point[0], point[1]]);
  }
  return parsed;
}

export function validateGraffitiEvent(value: unknown): GraffitiEvent | undefined {
  const event = objectValue(value);
  if (!event || typeof event.type !== "string") return;

  if (event.type === "stroke") {
    const parsedPoints = points(event.points);
    if (!parsedPoints || !color(event.color) || !brushWidth(event.width)) return;
    return { type: "stroke", points: parsedPoints, color: event.color, width: event.width };
  }

  if (event.type === "erase") {
    const parsedPoints = points(event.points);
    if (!parsedPoints || !brushWidth(event.width)) return;
    return { type: "erase", points: parsedPoints, width: event.width };
  }

  if (event.type === "text") {
    if (
      !coordinate(event.x, WALL_WIDTH) ||
      !coordinate(event.y, WALL_HEIGHT) ||
      typeof event.text !== "string" ||
      Array.from(event.text).length === 0 ||
      Array.from(event.text).length > MAX_TEXT_LENGTH ||
      !color(event.color) ||
      !finiteNumber(event.size) ||
      event.size < 8 ||
      event.size > 192
    ) return;
    return {
      type: "text",
      x: event.x,
      y: event.y,
      text: event.text,
      color: event.color,
      size: event.size,
    };
  }

  if (event.type !== "shape" || !color(event.color) || !brushWidth(event.width)) return;
  if (event.shape === "circle") {
    if (
      !coordinate(event.x, WALL_WIDTH) ||
      !coordinate(event.y, WALL_HEIGHT) ||
      !finiteNumber(event.radius) ||
      event.radius < 1 ||
      event.radius > Math.max(WALL_WIDTH, WALL_HEIGHT) ||
      event.x - event.radius < 0 ||
      event.x + event.radius > WALL_WIDTH ||
      event.y - event.radius < 0 ||
      event.y + event.radius > WALL_HEIGHT
    ) return;
    return {
      type: "shape",
      shape: "circle",
      x: event.x,
      y: event.y,
      radius: event.radius,
      color: event.color,
      width: event.width,
    };
  }

  if (event.shape === "rectangle") {
    if (
      !coordinate(event.x, WALL_WIDTH) ||
      !coordinate(event.y, WALL_HEIGHT) ||
      !finiteNumber(event.rectWidth) ||
      !finiteNumber(event.rectHeight) ||
      Math.abs(event.rectWidth) > WALL_WIDTH ||
      Math.abs(event.rectHeight) > WALL_HEIGHT ||
      event.rectWidth === 0 ||
      event.rectHeight === 0 ||
      !coordinate(event.x + event.rectWidth, WALL_WIDTH) ||
      !coordinate(event.y + event.rectHeight, WALL_HEIGHT)
    ) return;
    return {
      type: "shape",
      shape: "rectangle",
      x: event.x,
      y: event.y,
      rectWidth: event.rectWidth,
      rectHeight: event.rectHeight,
      color: event.color,
      width: event.width,
    };
  }

  if (event.shape === "line" || event.shape === "arrow") {
    if (
      !coordinate(event.x1, WALL_WIDTH) ||
      !coordinate(event.y1, WALL_HEIGHT) ||
      !coordinate(event.x2, WALL_WIDTH) ||
      !coordinate(event.y2, WALL_HEIGHT)
    ) return;
    return {
      type: "shape",
      shape: event.shape,
      x1: event.x1,
      y1: event.y1,
      x2: event.x2,
      y2: event.y2,
      color: event.color,
      width: event.width,
    };
  }
}

export function graffitiBatch(events: GraffitiEvent[]): GraffitiBatch {
  if (events.length < 1) throw new Error("Add at least one mark before posting.");
  if (events.length > MAX_EVENTS_PER_POST) {
    throw new Error(`A post can contain at most ${MAX_EVENTS_PER_POST} events.`);
  }
  const validated = events.map(validateGraffitiEvent);
  if (validated.some((event) => !event)) throw new Error("Draft contains an invalid event.");
  return {
    protocol: WALL_PROTOCOL,
    version: WALL_VERSION,
    type: "batch",
    canvas: [WALL_WIDTH, WALL_HEIGHT],
    events: validated as GraffitiEvent[],
  };
}

export function serializeGraffitiBatch(events: GraffitiEvent[]): string {
  const batch = graffitiBatch(events);
  let payload: string | undefined;
  try {
    const binary = encodeWallV2Payload(batch.events);
    const decoded = decodeWallV2Payload(binary);
    if (decoded.canvas[0] === WALL_WIDTH && decoded.canvas[1] === WALL_HEIGHT &&
      decoded.events.length === batch.events.length &&
      decoded.events.every((event) => validateGraffitiEvent(event) !== undefined)) {
      payload = binary;
    }
  } catch {
    // Keep valid v1 events when integer quantization cannot represent them.
  }
  payload ??= JSON.stringify(batch);
  const size = new TextEncoder().encode(payload).length;
  if (size > MAX_PAYLOAD_BYTES) {
    throw new Error(`Post is ${size.toLocaleString()} bytes; the limit is ${MAX_PAYLOAD_BYTES.toLocaleString()} bytes.`);
  }
  return payload;
}

export function parseGraffitiPayload(payload: string): GraffitiBatch | undefined {
  if (new TextEncoder().encode(payload).length > MAX_PAYLOAD_BYTES) return;
  if (payload.startsWith(WALL_BINARY_PREFIX)) {
    try {
      const decoded = decodeWallV2Payload(payload);
      if (decoded.canvas[0] !== WALL_WIDTH || decoded.canvas[1] !== WALL_HEIGHT) return;
      const events = decoded.events.map(validateGraffitiEvent);
      if (events.some((event) => !event)) return;
      return {
        protocol: WALL_PROTOCOL,
        version: WALL_BINARY_VERSION,
        type: "batch",
        canvas: [WALL_WIDTH, WALL_HEIGHT],
        events: events as GraffitiEvent[],
      };
    } catch {
      return;
    }
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    return;
  }
  const value = objectValue(decoded);
  if (!value) return;

  if (value.protocol === WALL_PROTOCOL && value.version === WALL_VERSION && value.type === "batch") {
    if (
      !Array.isArray(value.canvas) ||
      value.canvas[0] !== WALL_WIDTH ||
      value.canvas[1] !== WALL_HEIGHT ||
      !Array.isArray(value.events) ||
      value.events.length < 1 ||
      value.events.length > MAX_EVENTS_PER_POST
    ) return;
    const events = value.events.map(validateGraffitiEvent);
    if (events.some((event) => !event)) return;
    return graffitiBatch(events as GraffitiEvent[]);
  }

  // Early design fixtures used a single versioned Event instead of the batch envelope.
  if (value.version === WALL_VERSION) {
    const event = validateGraffitiEvent(value);
    if (event) return graffitiBatch([event]);
  }
}

export function recordsFromMessages(messages: Message[], seenAt = Date.now()): GraffitiRecord[] {
  const records: GraffitiRecord[] = [];
  for (const message of messages) {
    const batch = parseGraffitiPayload(message.payload);
    if (!batch) continue;
    batch.events.forEach((event, eventIndex) => {
      const compInputIndex = message.compInputIndex ?? 0;
      records.push({
        eventId: `${message.txHash}:${compInputIndex}:${eventIndex}`,
        txHash: message.txHash,
        eventIndex,
        event,
        status: message.status,
        author: message.author,
        signed: message.author !== "Anonymous",
        blockNumber: message.blockNumber,
        blockHash: message.blockHash,
        timestamp: message.timestamp,
        transactionIndex: message.transactionIndex,
        compInputIndex,
        seenAt,
      });
    });
  }
  return records.sort(compareGraffitiRecords);
}

export function compareGraffitiRecords(a: GraffitiRecord, b: GraffitiRecord): number {
  if (a.status !== b.status) return a.status === "confirmed" ? -1 : 1;
  if (a.status === "pending") {
    if (a.seenAt !== b.seenAt) return a.seenAt - b.seenAt;
    return a.eventId.localeCompare(b.eventId);
  }
  const aBlock = a.blockNumber ?? 0n;
  const bBlock = b.blockNumber ?? 0n;
  if (aBlock !== bBlock) return aBlock < bBlock ? -1 : 1;
  const aTx = a.transactionIndex ?? Number.MAX_SAFE_INTEGER;
  const bTx = b.transactionIndex ?? Number.MAX_SAFE_INTEGER;
  if (aTx !== bTx) return aTx - bTx;
  const aInput = a.compInputIndex ?? 0;
  const bInput = b.compInputIndex ?? 0;
  if (aInput !== bInput) return aInput - bInput;
  if (a.eventIndex !== b.eventIndex) return a.eventIndex - b.eventIndex;
  return a.txHash.localeCompare(b.txHash);
}

export function mergeGraffitiRecords(...groups: GraffitiRecord[][]): GraffitiRecord[] {
  const merged = new Map<string, GraffitiRecord>();
  for (const group of groups) {
    for (const record of group) {
      const previous = merged.get(record.eventId);
      if (!previous || previous.status === "pending" || record.status === "confirmed") {
        merged.set(record.eventId, record);
      }
    }
  }
  return Array.from(merged.values()).sort(compareGraffitiRecords);
}

export function reconcileConfirmedHistory(
  cached: GraffitiRecord[],
  fresh: GraffitiRecord[],
  scannedMessages: Message[],
): GraffitiRecord[] {
  const freshTxHashes = new Set(scannedMessages.map((message) => message.txHash));
  const scannedBlocks = scannedMessages
    .map((message) => message.blockNumber)
    .filter((block): block is bigint => block !== undefined);
  const oldestScannedBlock = scannedBlocks.length
    ? scannedBlocks.reduce((oldest, block) => block < oldest ? block : oldest)
    : undefined;
  const retained = cached.filter((record) => {
    if (record.status !== "confirmed") return false;
    if (freshTxHashes.has(record.txHash)) return true;
    // Missing records inside the authoritative fresh window were orphaned.
    // Older IndexedDB history is outside this scan and remains retained.
    return oldestScannedBlock !== undefined &&
      record.blockNumber !== undefined &&
      record.blockNumber < oldestScannedBlock;
  });
  return mergeGraffitiRecords(retained, fresh);
}

export function eventSummary(event: GraffitiEvent, batchSize = 1): string {
  if (batchSize > 1) return `added ${batchSize} marks`;
  if (event.type === "stroke") return "drew a stroke";
  if (event.type === "erase") return "erased an area";
  if (event.type === "text") {
    const text = Array.from(event.text).slice(0, 24).join("");
    return `wrote “${text}${Array.from(event.text).length > 24 ? "…" : ""}”`;
  }
  return `added a ${event.shape}`;
}

export function eventBounds(event: GraffitiEvent): EventBounds {
  if (event.type === "stroke" || event.type === "erase") {
    const xs = event.points.map(([x]) => x);
    const ys = event.points.map(([, y]) => y);
    const pad = event.width / 2;
    return {
      minX: Math.max(0, Math.min(...xs) - pad),
      minY: Math.max(0, Math.min(...ys) - pad),
      maxX: Math.min(WALL_WIDTH, Math.max(...xs) + pad),
      maxY: Math.min(WALL_HEIGHT, Math.max(...ys) + pad),
    };
  }
  if (event.type === "text") {
    return {
      minX: event.x,
      minY: Math.max(0, event.y - event.size),
      maxX: Math.min(WALL_WIDTH, event.x + event.size * Math.max(1, Array.from(event.text).length) * 0.65),
      maxY: Math.min(WALL_HEIGHT, event.y + event.size * 0.25),
    };
  }
  if (event.shape === "circle") {
    return {
      minX: Math.max(0, event.x - event.radius),
      minY: Math.max(0, event.y - event.radius),
      maxX: Math.min(WALL_WIDTH, event.x + event.radius),
      maxY: Math.min(WALL_HEIGHT, event.y + event.radius),
    };
  }
  if (event.shape === "rectangle") {
    return {
      minX: Math.max(0, Math.min(event.x, event.x + event.rectWidth)),
      minY: Math.max(0, Math.min(event.y, event.y + event.rectHeight)),
      maxX: Math.min(WALL_WIDTH, Math.max(event.x, event.x + event.rectWidth)),
      maxY: Math.min(WALL_HEIGHT, Math.max(event.y, event.y + event.rectHeight)),
    };
  }
  return {
    minX: Math.min(event.x1, event.x2),
    minY: Math.min(event.y1, event.y2),
    maxX: Math.max(event.x1, event.x2),
    maxY: Math.max(event.y1, event.y2),
  };
}

function perpendicularDistance(point: Point, start: Point, end: Point): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  return Math.abs(dy * point[0] - dx * point[1] + end[0] * start[1] - end[1] * start[0]) /
    Math.hypot(dx, dy);
}

export function simplifyPoints(input: Point[], epsilon = 1.5): Point[] {
  if (input.length <= 2) return input.map(([x, y]) => [x, y]);
  let distance = 0;
  let index = 0;
  for (let i = 1; i < input.length - 1; i++) {
    const candidate = perpendicularDistance(input[i], input[0], input[input.length - 1]);
    if (candidate > distance) {
      distance = candidate;
      index = i;
    }
  }
  if (distance <= epsilon) return [input[0], input[input.length - 1]];
  const left = simplifyPoints(input.slice(0, index + 1), epsilon);
  const right = simplifyPoints(input.slice(index), epsilon);
  return [...left.slice(0, -1), ...right].slice(0, MAX_POINTS_PER_STROKE);
}

export function formatGraffitiAuthor(record: GraffitiRecord): string {
  if (!record.signed) return "👻 Anonymous";
  if (record.author.length <= 18) return `${record.author} · ✓ Signed`;
  return `${record.author.slice(0, 8)}…${record.author.slice(-6)} · ✓ Signed`;
}
