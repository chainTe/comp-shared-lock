import {
  MAX_EVENTS_PER_POST,
  WALL_HEIGHT,
  WALL_WIDTH,
  eventBounds,
  validateGraffitiEvent,
  type GraffitiEvent,
  type Point,
} from "./compWall.ts";

export type AiArtStyle = "marker" | "neon" | "minimal" | "wild";
export type AiPlacement = "auto" | "left" | "center" | "right";

export interface AiArtworkOptions {
  prompt: string;
  style?: AiArtStyle;
  placement?: AiPlacement;
  variation?: number;
  existingEvents?: GraffitiEvent[];
}

export interface AiArtworkPlan {
  title: string;
  note: string;
  subject: "rocket" | "robot" | "garden" | "cat" | "heart" | "ckb" | "abstract";
  seed: number;
  palette: string[];
  placement: Exclude<AiPlacement, "auto">;
  vertical: "top" | "middle" | "bottom";
  events: GraffitiEvent[];
}

const PALETTES: Record<AiArtStyle, string[]> = {
  marker: ["#ff4f87", "#7861ff", "#ffb020", "#2387ff", "#20a46b", "#151515"],
  neon: ["#7861ff", "#2387ff", "#ff4f87", "#20a46b", "#ffb020", "#151515"],
  minimal: ["#151515", "#f05a3c", "#ffb020", "#2387ff", "#20a46b", "#7861ff"],
  wild: ["#f05a3c", "#ff4f87", "#ffb020", "#7861ff", "#20a46b", "#2387ff"],
};

const PLACEMENT_CENTER = {
  left: 420,
  center: 960,
  right: 1500,
} as const;

function hashText(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomFrom(seed: number): () => number {
  let state = seed || 0x6d2b79f5;
  return () => {
    state |= 0;
    state = state + 0x6d2b79f5 | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function subjectFromPrompt(prompt: string): AiArtworkPlan["subject"] {
  if (/rocket|moon|space|火箭|月球|月亮|太空|宇宙/i.test(prompt)) return "rocket";
  if (/robot|android|机器人|機器人|ai\b|人工智能/i.test(prompt)) return "robot";
  if (/garden|flower|nature|花|花园|花園|植物|草地|树|樹/i.test(prompt)) return "garden";
  if (/cat|kitty|猫|貓/i.test(prompt)) return "cat";
  if (/heart|love|爱心|愛心|心形|爱|愛/i.test(prompt)) return "heart";
  if (/ckb|nervos|comp|社区|社區|共创|共創/i.test(prompt)) return "ckb";
  return "abstract";
}

interface PlacementResult {
  placement: Exclude<AiPlacement, "auto">;
  vertical: "top" | "middle" | "bottom";
  cx: number;
  cy: number;
  crowded: boolean;
}

function choosePosition(
  requested: AiPlacement,
  existingEvents: GraffitiEvent[],
): PlacementResult {
  if (requested !== "auto") {
    return { placement: requested, vertical: "middle", cx: PLACEMENT_CENTER[requested], cy: 535, crowded: false };
  }
  const xCandidates: Array<[Exclude<AiPlacement, "auto">, number]> = [
    ["left", 350],
    ["center", 960],
    ["right", 1570],
  ];
  const yCandidates: Array<["top" | "bottom", number]> = [["top", 280], ["bottom", 840]];
  let best: PlacementResult = { placement: "left", vertical: "top", cx: 350, cy: 280, crowded: false };
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [placement, centerX] of xCandidates) {
    for (const [vertical, centerY] of yCandidates) {
      const region = { minX: centerX - 300, maxX: centerX + 300, minY: centerY - 290, maxY: centerY + 290 };
      let score = 0;
      for (const event of existingEvents) {
        const bounds = eventBounds(event);
        const width = Math.max(0, Math.min(region.maxX, bounds.maxX) - Math.max(region.minX, bounds.minX));
        const height = Math.max(0, Math.min(region.maxY, bounds.maxY) - Math.max(region.minY, bounds.minY));
        score += width * height + (width > 0 && height > 0 ? 18_000 : 0);
      }
      if (score < bestScore) {
        best = { placement, vertical, cx: centerX, cy: centerY, crowded: score > 70_000 };
        bestScore = score;
      }
    }
  }
  return best;
}

interface SketchContext {
  cx: number;
  cy: number;
  scale: number;
  palette: string[];
  random: () => number;
}

function point(context: SketchContext, x: number, y: number): Point {
  return [
    Math.round(Math.max(0, Math.min(WALL_WIDTH, context.cx + x * context.scale)) * 10) / 10,
    Math.round(Math.max(0, Math.min(WALL_HEIGHT, context.cy + y * context.scale)) * 10) / 10,
  ];
}

function stroke(context: SketchContext, points: Array<[number, number]>, color = 0, width = 12): GraffitiEvent {
  return {
    type: "stroke",
    points: points.map(([x, y]) => point(context, x, y)),
    color: context.palette[color % context.palette.length],
    width: Math.max(2, Math.round(width * context.scale)),
  };
}

function line(context: SketchContext, from: [number, number], to: [number, number], color = 0, width = 10, arrow = false): GraffitiEvent {
  const [x1, y1] = point(context, ...from);
  const [x2, y2] = point(context, ...to);
  return {
    type: "shape",
    shape: arrow ? "arrow" : "line",
    x1,
    y1,
    x2,
    y2,
    color: context.palette[color % context.palette.length],
    width: Math.max(2, Math.round(width * context.scale)),
  };
}

function circle(context: SketchContext, at: [number, number], radius: number, color = 0, width = 10): GraffitiEvent {
  const [x, y] = point(context, ...at);
  return {
    type: "shape",
    shape: "circle",
    x,
    y,
    radius: Math.max(2, Math.round(radius * context.scale)),
    color: context.palette[color % context.palette.length],
    width: Math.max(2, Math.round(width * context.scale)),
  };
}

function rectangle(context: SketchContext, at: [number, number], size: [number, number], color = 0, width = 10): GraffitiEvent {
  const [x, y] = point(context, ...at);
  return {
    type: "shape",
    shape: "rectangle",
    x,
    y,
    rectWidth: Math.round(size[0] * context.scale),
    rectHeight: Math.round(size[1] * context.scale),
    color: context.palette[color % context.palette.length],
    width: Math.max(2, Math.round(width * context.scale)),
  };
}

function label(context: SketchContext, value: string, at: [number, number], color = 0, size = 64): GraffitiEvent {
  const [x, y] = point(context, ...at);
  return {
    type: "text",
    x,
    y,
    text: Array.from(value).slice(0, 24).join(""),
    color: context.palette[color % context.palette.length],
    size: Math.max(16, Math.round(size * context.scale)),
  };
}

function stars(context: SketchContext, count = 4): GraffitiEvent[] {
  const events: GraffitiEvent[] = [];
  for (let index = 0; index < count; index++) {
    const x = -320 + context.random() * 640;
    const y = -330 + context.random() * 660;
    const size = 12 + context.random() * 16;
    events.push(line(context, [x - size, y], [x + size, y], 3, 7));
    events.push(line(context, [x, y - size], [x, y + size], 3, 7));
  }
  return events;
}

function rocket(context: SketchContext): GraffitiEvent[] {
  return [
    stroke(context, [[0, -260], [-55, -205], [-88, -115], [-82, 18], [-38, 110], [0, 140], [38, 110], [82, 18], [88, -115], [55, -205], [0, -260]], 1, 14),
    circle(context, [0, -88], 42, 0, 12),
    stroke(context, [[-82, -2], [-146, 76], [-76, 58]], 1, 13),
    stroke(context, [[82, -2], [146, 76], [76, 58]], 1, 13),
    stroke(context, [[-38, 112], [-24, 195], [2, 150], [25, 216], [39, 112]], 2, 14),
    line(context, [-110, 156], [-215, 238], 3, 10),
    circle(context, [225, -205], 92, 2, 10),
    circle(context, [195, -230], 17, 2, 7),
    circle(context, [252, -176], 12, 2, 7),
    ...stars(context, 3),
  ];
}

function robot(context: SketchContext): GraffitiEvent[] {
  return [
    rectangle(context, [-170, -205], [340, 250], 1, 14),
    rectangle(context, [-135, 80], [270, 210], 0, 14),
    circle(context, [-72, -90], 30, 3, 12),
    circle(context, [72, -90], 30, 3, 12),
    line(context, [-62, -5], [62, -5], 2, 11),
    line(context, [0, -205], [0, -285], 1, 11),
    circle(context, [0, -302], 16, 0, 9),
    line(context, [-170, -112], [-222, -112], 1, 12),
    line(context, [170, -112], [222, -112], 1, 12),
    line(context, [-135, 130], [-240, 218], 4, 14),
    line(context, [135, 130], [240, 218], 4, 14),
    line(context, [-74, 290], [-110, 348], 1, 14),
    line(context, [74, 290], [110, 348], 1, 14),
    circle(context, [0, 166], 48, 4, 11),
    label(context, "AI", [-50, 188], 5, 58),
    ...stars(context, 2),
  ];
}

function garden(context: SketchContext): GraffitiEvent[] {
  const events: GraffitiEvent[] = [
    stroke(context, [[-330, 245], [-220, 226], [-110, 252], [0, 224], [110, 250], [220, 228], [330, 244]], 4, 15),
    circle(context, [245, -235], 68, 2, 13),
  ];
  const positions = [-225, -75, 85, 235];
  positions.forEach((x, index) => {
    const height = 80 + (index % 2) * 70;
    events.push(line(context, [x, 225], [x, -height], 4, 12));
    events.push(circle(context, [x, -height - 42], 42, index, 12));
    events.push(circle(context, [x - 33, -height - 18], 34, index, 10));
    events.push(circle(context, [x + 33, -height - 18], 34, index, 10));
    events.push(stroke(context, [[x, 92], [x - 48, 48], [x - 12, 34]], 4, 9));
  });
  return events;
}

function cat(context: SketchContext): GraffitiEvent[] {
  return [
    stroke(context, [[-185, -95], [-208, -242], [-90, -174], [0, -205], [90, -174], [208, -242], [185, -95], [198, 60], [125, 185], [0, 230], [-125, 185], [-198, 60], [-185, -95]], 0, 15),
    circle(context, [-78, -40], 23, 3, 10),
    circle(context, [78, -40], 23, 3, 10),
    stroke(context, [[-22, 22], [0, 39], [22, 22]], 1, 10),
    stroke(context, [[-55, 78], [0, 105], [55, 78]], 1, 10),
    line(context, [-68, 46], [-230, 12], 5, 8),
    line(context, [-72, 72], [-238, 82], 5, 8),
    line(context, [68, 46], [230, 12], 5, 8),
    line(context, [72, 72], [238, 82], 5, 8),
    stroke(context, [[176, 176], [264, 206], [308, 160], [298, 86]], 1, 14),
    ...stars(context, 2),
  ];
}

function heart(context: SketchContext): GraffitiEvent[] {
  const outline: Array<[number, number]> = [];
  for (let index = 0; index <= 48; index++) {
    const t = Math.PI * 2 * index / 48;
    outline.push([16 * Math.sin(t) ** 3 * 16, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) * 16]);
  }
  return [
    stroke(context, outline, 0, 17),
    line(context, [-315, 0], [-210, 0], 1, 10),
    line(context, [210, 0], [315, 0], 1, 10),
    line(context, [0, -315], [0, -235], 2, 10),
    line(context, [0, 250], [0, 330], 2, 10),
    ...stars(context, 3),
  ];
}

function ckb(context: SketchContext): GraffitiEvent[] {
  return [
    circle(context, [0, 0], 245, 1, 12),
    circle(context, [0, 0], 172, 3, 10),
    stroke(context, [[-285, -40], [-185, -128], [-50, -148], [82, -104], [206, -18], [282, 86]], 0, 16),
    stroke(context, [[-282, 86], [-190, 8], [-58, -16], [75, 26], [188, 112], [276, 170]], 4, 13),
    label(context, "CKB", [-126, 22], 5, 92),
    label(context, "♥ AI", [-100, 136], 0, 54),
    line(context, [-320, -252], [-246, -196], 2, 9, true),
    line(context, [250, 208], [322, 266], 2, 9, true),
    ...stars(context, 2),
  ];
}

function abstract(context: SketchContext): GraffitiEvent[] {
  const events: GraffitiEvent[] = [];
  for (let ribbon = 0; ribbon < 6; ribbon++) {
    const points: Array<[number, number]> = [];
    const phase = context.random() * Math.PI * 2;
    const amplitude = 55 + context.random() * 95;
    for (let step = 0; step <= 18; step++) {
      const x = -330 + step * (660 / 18);
      const y = -210 + ribbon * 82 + Math.sin(step * .62 + phase) * amplitude;
      points.push([x, y]);
    }
    events.push(stroke(context, points, ribbon, 9 + ribbon % 3 * 4));
  }
  for (let index = 0; index < 6; index++) {
    events.push(circle(
      context,
      [-270 + context.random() * 540, -280 + context.random() * 560],
      18 + context.random() * 54,
      index + 1,
      8,
    ));
  }
  return events;
}

function quotedText(prompt: string): string | undefined {
  const match = prompt.match(/[“\"']([^”\"']{1,40})[”\"']/);
  return match?.[1]?.trim();
}

function titleFor(subject: AiArtworkPlan["subject"]): string {
  return ({
    rocket: "Moonbound Signal",
    robot: "Friendly Machine",
    garden: "Shared Garden",
    cat: "Chain Cat",
    heart: "Public Heart",
    ckb: "CKB × AI",
    abstract: "Open Signal",
  } as const)[subject];
}

export function generateAiArtwork(options: AiArtworkOptions): AiArtworkPlan {
  const prompt = options.prompt.trim() || "一幅属于所有人的抽象链上涂鸦";
  const style = options.style ?? "marker";
  const variation = Math.max(0, Math.floor(options.variation ?? 0));
  const subject = subjectFromPrompt(prompt);
  const seed = hashText(`${prompt}\n${style}\n${variation}`);
  const placementHint: AiPlacement = (options.placement ?? "auto") !== "auto"
    ? options.placement as AiPlacement
    : /右侧|右边|\bright\b/i.test(prompt) ? "right"
    : /左侧|左边|\bleft\b/i.test(prompt) ? "left"
    : /中间|中央|居中|\bcent(?:er|re)\b/i.test(prompt) ? "center"
    : "auto";
  const position = choosePosition(placementHint, options.existingEvents ?? []);
  const baseScale = style === "minimal" ? .72 : style === "wild" ? .9 : .82;
  const densityScale = (options.placement ?? "auto") === "auto" && (options.existingEvents?.length ?? 0) > 12
    ? .62
    : 1;
  const context: SketchContext = {
    cx: position.cx,
    cy: position.cy,
    scale: baseScale * densityScale,
    palette: PALETTES[style],
    random: randomFrom(seed),
  };

  let events = ({ rocket, robot, garden, cat, heart, ckb, abstract } as const)[subject](context);
  const text = quotedText(prompt);
  const duplicatesBuiltInLabel = (subject === "robot" && text?.toUpperCase() === "AI") ||
    (subject === "ckb" && /^(CKB|AI|CKB\s*[×X&+]\s*AI)$/i.test(text ?? ""));
  if (text && !duplicatesBuiltInLabel) events.push(label(context, text, [-290, 342], 5, 48));
  events = events
    .map((event) => validateGraffitiEvent(event))
    .filter((event): event is GraffitiEvent => event !== undefined)
    .slice(0, MAX_EVENTS_PER_POST);

  return {
    title: titleFor(subject),
    note: `Placed ${position.vertical} ${position.placement} with ${style} marks · variation ${variation + 1}`,
    subject,
    seed,
    palette: [...context.palette],
    placement: position.placement,
    vertical: position.vertical,
    events,
  };
}

export function describeAiEvent(event: GraffitiEvent): string {
  if (event.type === "stroke") return `stroke · ${event.points.length} pts · ${event.color}`;
  if (event.type === "erase") return `erase · ${event.points.length} pts · ${event.width}px`;
  if (event.type === "text") return `text · “${event.text}”`;
  return `${event.shape} · ${event.color}`;
}
