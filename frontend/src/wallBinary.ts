import type { GraffitiEvent } from "./compWall";

export const WALL_BINARY_PREFIX = "CW2:";
const MAGIC = [0x43, 0x57, 0x02] as const;
const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;
const MAX_EVENTS = 64;
const MAX_POINTS = 2048;
const decoder = new TextDecoder("utf-8", { fatal: true });

function byte(out: number[], value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new Error("Invalid wall byte");
  out.push(value);
}

function u16(out: number[], value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error("Invalid wall u16");
  out.push(value & 0xff, value >>> 8);
}

function rgb(out: number[], color: string): void {
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error("Invalid wall color");
  for (let i = 1; i < 7; i += 2) byte(out, Number.parseInt(color.slice(i, i + 2), 16));
}

function varint(out: number[], value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error("Invalid wall delta");
  let remaining = value;
  while (remaining > 0x7f) {
    out.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  out.push(remaining);
}

function zigzag(value: number): number {
  return value < 0 ? -value * 2 - 1 : value * 2;
}

function pointSet(out: number[], points: [number, number][]): void {
  if (points.length < 2 || points.length > MAX_POINTS) throw new Error("Invalid wall point count");
  u16(out, points.length);
  let previousX = 0;
  let previousY = 0;
  points.forEach(([x, y], index) => {
    const currentX = Math.round(x);
    const currentY = Math.round(y);
    if (index === 0) {
      u16(out, currentX);
      u16(out, currentY);
    } else {
      varint(out, zigzag(currentX - previousX));
      varint(out, zigzag(currentY - previousY));
    }
    previousX = currentX;
    previousY = currentY;
  });
}

export function encodeWallBinary(events: GraffitiEvent[]): Uint8Array {
  if (events.length < 1 || events.length > MAX_EVENTS) throw new Error("Invalid wall event count");
  const out: number[] = [...MAGIC];
  u16(out, CANVAS_WIDTH);
  u16(out, CANVAS_HEIGHT);
  byte(out, events.length);

  for (const event of events) {
    if (event.type === "stroke") {
      byte(out, 1);
      rgb(out, event.color);
      byte(out, Math.round(event.width));
      pointSet(out, event.points);
    } else if (event.type === "erase") {
      byte(out, 2);
      byte(out, Math.round(event.width));
      pointSet(out, event.points);
    } else if (event.type === "text") {
      byte(out, 3);
      rgb(out, event.color);
      u16(out, Math.round(event.x));
      u16(out, Math.round(event.y));
      byte(out, Math.round(event.size));
      const utf8 = new TextEncoder().encode(event.text);
      if (decoder.decode(utf8) !== event.text) throw new Error("Wall text is not valid UTF-8");
      u16(out, utf8.length);
      out.push(...utf8);
    } else if (event.type === "shape") {
      const shapeCode = { circle: 4, rectangle: 5, line: 6, arrow: 7 }[event.shape];
      byte(out, shapeCode);
      rgb(out, event.color);
      byte(out, Math.round(event.width));
      if (event.shape === "circle") {
        u16(out, Math.round(event.x));
        u16(out, Math.round(event.y));
        u16(out, Math.round(event.radius));
      } else if (event.shape === "rectangle") {
        const left = Math.round(Math.min(event.x, event.x + event.rectWidth));
        const top = Math.round(Math.min(event.y, event.y + event.rectHeight));
        const right = Math.round(Math.max(event.x, event.x + event.rectWidth));
        const bottom = Math.round(Math.max(event.y, event.y + event.rectHeight));
        u16(out, left);
        u16(out, top);
        u16(out, right - left);
        u16(out, bottom - top);
      } else {
        u16(out, Math.round(event.x1));
        u16(out, Math.round(event.y1));
        u16(out, Math.round(event.x2));
        u16(out, Math.round(event.y2));
      }
    } else {
      throw new Error("Invalid wall event type");
    }
  }
  return Uint8Array.from(out);
}

export function decodeWallBinary(bytes: Uint8Array): { canvas: [number, number]; events: unknown[] } {
  let offset = 0;
  const take = (): number => {
    if (offset >= bytes.length) throw new Error("Truncated wall payload");
    return bytes[offset++];
  };
  const readU16 = (): number => take() | (take() << 8);
  const readRgb = (): string => {
    let color = "#";
    for (let i = 0; i < 3; i += 1) color += take().toString(16).padStart(2, "0");
    return color;
  };
  const readVarint = (): number => {
    let value = 0;
    for (let i = 0; i < 3; i += 1) {
      const part = take();
      value += (part & 0x7f) * 2 ** (i * 7);
      if ((part & 0x80) === 0) {
        if (value > 0xffff) throw new Error("Invalid wall delta");
        return value;
      }
    }
    throw new Error("Invalid wall varint");
  };
  const readPoints = (): [number, number][] => {
    const count = readU16();
    if (count < 2 || count > MAX_POINTS) throw new Error("Invalid wall point count");
    const points: [number, number][] = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i < count; i += 1) {
      if (i === 0) {
        x = readU16();
        y = readU16();
      } else {
        const dx = readVarint();
        const dy = readVarint();
        x += dx & 1 ? -(dx + 1) / 2 : dx / 2;
        y += dy & 1 ? -(dy + 1) / 2 : dy / 2;
      }
      points.push([x, y]);
    }
    return points;
  };

  if (take() !== MAGIC[0] || take() !== MAGIC[1] || take() !== MAGIC[2]) {
    throw new Error("Unknown wall binary version");
  }
  const canvas: [number, number] = [readU16(), readU16()];
  const count = take();
  if (count < 1 || count > MAX_EVENTS) throw new Error("Invalid wall event count");
  const events: unknown[] = [];
  for (let i = 0; i < count; i += 1) {
    const type = take();
    if (type === 1) {
      const color = readRgb();
      const width = take();
      events.push({ type: "stroke", color, width, points: readPoints() });
    } else if (type === 2) {
      const width = take();
      events.push({ type: "erase", width, points: readPoints() });
    } else if (type === 3) {
      const color = readRgb();
      const x = readU16();
      const y = readU16();
      const size = take();
      const length = readU16();
      if (offset + length > bytes.length) throw new Error("Truncated wall text");
      const text = decoder.decode(bytes.subarray(offset, offset + length));
      offset += length;
      events.push({ type: "text", color, x, y, size, text });
    } else if (type >= 4 && type <= 7) {
      const color = readRgb();
      const width = take();
      const x = readU16();
      const y = readU16();
      if (type === 4) events.push({ type: "shape", shape: "circle", color, width, x, y, radius: readU16() });
      else if (type === 5) events.push({ type: "shape", shape: "rectangle", color, width, x, y, rectWidth: readU16(), rectHeight: readU16() });
      else {
        const x2 = readU16();
        const y2 = readU16();
        events.push({ type: "shape", shape: type === 6 ? "line" : "arrow", color, width, x1: x, y1: y, x2, y2 });
      }
    } else {
      throw new Error("Unknown wall event type");
    }
  }
  if (offset !== bytes.length) throw new Error("Trailing wall payload bytes");
  return { canvas, events };
}

export function encodeWallV2Payload(events: GraffitiEvent[]): string {
  const bytes = encodeWallBinary(events);
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  }
  return WALL_BINARY_PREFIX + btoa(chunks.join(""));
}

export function decodeWallV2Payload(payload: string): { canvas: [number, number]; events: unknown[] } {
  if (!payload.startsWith(WALL_BINARY_PREFIX)) throw new Error("Unknown wall payload");
  const encoded = payload.slice(WALL_BINARY_PREFIX.length);
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("Invalid wall base64");
  }
  const binary = atob(encoded);
  if (btoa(binary) !== encoded) throw new Error("Noncanonical wall base64");
  return decodeWallBinary(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}
