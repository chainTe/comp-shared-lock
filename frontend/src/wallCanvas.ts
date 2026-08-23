import {
  WALL_HEIGHT,
  WALL_WIDTH,
  eventBounds,
  type EventBounds,
  type GraffitiEvent,
  type GraffitiRecord,
} from "./compWall";

export interface RenderOptions {
  alpha?: number;
  selected?: boolean;
}

export function configureWallCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  canvas.width = WALL_WIDTH;
  canvas.height = WALL_HEIGHT;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("Canvas 2D is not supported by this browser.");
  context.lineCap = "round";
  context.lineJoin = "round";
  return context;
}

function strokePoints(
  context: CanvasRenderingContext2D,
  points: [number, number][],
  width: number,
): void {
  const [first, ...rest] = points;
  context.lineWidth = width;
  context.beginPath();
  context.moveTo(first[0], first[1]);
  if (rest.length === 1) {
    context.lineTo(rest[0][0], rest[0][1]);
  } else {
    for (let index = 0; index < rest.length - 1; index++) {
      const current = rest[index];
      const next = rest[index + 1];
      context.quadraticCurveTo(
        current[0],
        current[1],
        (current[0] + next[0]) / 2,
        (current[1] + next[1]) / 2,
      );
    }
    const last = rest[rest.length - 1];
    context.lineTo(last[0], last[1]);
  }
  context.stroke();
}

function drawArrowHead(
  context: CanvasRenderingContext2D,
  event: { x1: number; y1: number; x2: number; y2: number; width: number },
): void {
  const angle = Math.atan2(event.y2 - event.y1, event.x2 - event.x1);
  const size = Math.max(18, event.width * 4);
  context.beginPath();
  context.moveTo(event.x2, event.y2);
  context.lineTo(event.x2 - size * Math.cos(angle - Math.PI / 6), event.y2 - size * Math.sin(angle - Math.PI / 6));
  context.moveTo(event.x2, event.y2);
  context.lineTo(event.x2 - size * Math.cos(angle + Math.PI / 6), event.y2 - size * Math.sin(angle + Math.PI / 6));
  context.stroke();
}

export function renderGraffitiEvent(
  context: CanvasRenderingContext2D,
  event: GraffitiEvent,
  options: RenderOptions = {},
): void {
  context.save();
  context.globalAlpha = options.alpha ?? 1;
  context.lineCap = "round";
  context.lineJoin = "round";

  if (event.type === "stroke") {
    context.globalCompositeOperation = "source-over";
    context.strokeStyle = event.color;
    strokePoints(context, event.points, event.width);
  } else if (event.type === "erase") {
    context.globalCompositeOperation = "destination-out";
    context.strokeStyle = "#000000";
    strokePoints(context, event.points, event.width);
  } else if (event.type === "text") {
    context.globalCompositeOperation = "source-over";
    context.fillStyle = event.color;
    context.font = `700 ${event.size}px "Avenir Next", "Trebuchet MS", sans-serif`;
    context.textBaseline = "alphabetic";
    context.fillText(event.text, event.x, event.y, WALL_WIDTH - event.x);
  } else {
    context.globalCompositeOperation = "source-over";
    context.strokeStyle = event.color;
    context.lineWidth = event.width;
    context.beginPath();
    if (event.shape === "circle") {
      context.arc(event.x, event.y, event.radius, 0, Math.PI * 2);
    } else if (event.shape === "rectangle") {
      context.rect(event.x, event.y, event.rectWidth, event.rectHeight);
    } else {
      context.moveTo(event.x1, event.y1);
      context.lineTo(event.x2, event.y2);
    }
    context.stroke();
    if (event.shape === "arrow") drawArrowHead(context, event);
  }

  if (options.selected) {
    renderHighlight(context, eventBounds(event));
  }
  context.restore();
}

export function renderHighlight(context: CanvasRenderingContext2D, bounds: EventBounds): void {
  const padding = 18;
  context.save();
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = 1;
  context.strokeStyle = "#ff4f87";
  context.lineWidth = 6;
  context.setLineDash([16, 12]);
  context.shadowColor = "rgba(255, 79, 135, .45)";
  context.shadowBlur = 18;
  context.strokeRect(
    bounds.minX - padding,
    bounds.minY - padding,
    bounds.maxX - bounds.minX + padding * 2,
    bounds.maxY - bounds.minY + padding * 2,
  );
  context.restore();
}

export function renderEventSequence(
  canvas: HTMLCanvasElement,
  events: GraffitiEvent[],
  base?: HTMLCanvasElement,
  eventAlpha = 1,
  selected?: GraffitiEvent,
): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, WALL_WIDTH, WALL_HEIGHT);
  if (base) context.drawImage(base, 0, 0);
  for (const event of events) renderGraffitiEvent(context, event, { alpha: eventAlpha });
  if (selected) renderHighlight(context, eventBounds(selected));
}

export function renderRecordSequence(
  canvas: HTMLCanvasElement,
  records: GraffitiRecord[],
  selectedId?: string,
): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, WALL_WIDTH, WALL_HEIGHT);
  for (const record of records) {
    renderGraffitiEvent(context, record.event, {
      alpha: record.status === "pending" ? 0.68 : 1,
      selected: record.eventId === selectedId,
    });
  }
}

export function canvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number): [number, number] {
  const rect = canvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(WALL_WIDTH, ((clientX - rect.left) / rect.width) * WALL_WIDTH));
  const y = Math.max(0, Math.min(WALL_HEIGHT, ((clientY - rect.top) / rect.height) * WALL_HEIGHT));
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Snapshot encoding failed.")), "image/png");
  });
}

export async function drawSnapshotBlob(canvas: HTMLCanvasElement, blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Snapshot decoding failed."));
      image.src = url;
    });
    const context = canvas.getContext("2d");
    context?.clearRect(0, 0, WALL_WIDTH, WALL_HEIGHT);
    context?.drawImage(image, 0, 0, WALL_WIDTH, WALL_HEIGHT);
  } finally {
    URL.revokeObjectURL(url);
  }
}
