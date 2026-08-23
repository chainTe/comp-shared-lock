import {
  WALL_HEIGHT,
  WALL_WIDTH,
  eventSummary,
  formatGraffitiAuthor,
  mergeGraffitiRecords,
  reconcileConfirmedHistory,
  recordsFromMessages,
  serializeGraffitiBatch,
  simplifyPoints,
  type GraffitiEvent,
  type GraffitiRecord,
  type Point,
  type ShapeKind,
} from "../compWall";
import { channelKind, channelRoute } from "../channelNames";
import {
  anonymousIdentity,
  connectWallet,
  disconnectWallet,
  isWalletConnected,
} from "../identity";
import { loadPendingMessages, resolveChannelState, trackPendingTx } from "../resolver";
import { readCachedChannels, readCachedMessages } from "../scanCache";
import { postAnonymous, postSigned } from "../txBuilder";
import type { Channel, ChannelState, Message, SigningIdentity } from "../types";
import { formatCapacity, truncateHash } from "../utils";
import {
  canvasPoint,
  canvasToBlob,
  configureWallCanvas,
  drawSnapshotBlob,
  renderEventSequence,
} from "../wallCanvas";
import {
  readPendingWallPosts,
  clearWallSnapshot,
  readWallDraft,
  readWallRecords,
  readWallSnapshot,
  removePendingWallPost,
  savePendingWallPost,
  saveWallDraft,
  saveWallRecords,
  saveWallSnapshot,
  type WallSnapshot,
} from "../wallCache";
import {
  EXPLORER_TX_URL,
  MESSAGE_FEE_RATE,
  MIN_CELL_CAPACITY,
  PENDING_POLL_INTERVAL_MS,
} from "../rpc";
import { el, toast } from "./common";

type Tool = "pen" | "eraser" | "text" | "shape";

const COLORS = ["#151515", "#ff4f87", "#7861ff", "#ffb020", "#20a46b", "#2387ff", "#f05a3c"];
const REPLAY_SPEEDS = [1, 4, 16, 64] as const;

function shortWallName(name: string): string {
  return `#${name.replace(/^#/, "")}`;
}

function relativeTime(timestamp?: bigint): string {
  if (timestamp === undefined) return "just now";
  const delta = Math.max(0, Date.now() - Number(timestamp));
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function toolButton(tool: Tool, icon: string, label: string, shortcut: string): HTMLButtonElement {
  const button = el(
    "button",
    {
      className: "tool-button",
      type: "button",
      title: `${label} (${shortcut})`,
      "aria-label": `${label}, shortcut ${shortcut}`,
      "data-tool": tool,
    },
  ) as HTMLButtonElement;
  button.appendChild(el("span", { className: "tool-icon", "aria-hidden": "true" }, icon));
  button.appendChild(el("span", { className: "tool-label" }, label));
  return button;
}

function shapeFromDrag(
  kind: ShapeKind,
  start: Point,
  end: Point,
  color: string,
  width: number,
): GraffitiEvent {
  if (kind === "circle") {
    const center: Point = [
      Math.max(1, Math.min(WALL_WIDTH - 1, start[0])),
      Math.max(1, Math.min(WALL_HEIGHT - 1, start[1])),
    ];
    const radius = Math.min(
      Math.max(1, Math.hypot(end[0] - center[0], end[1] - center[1])),
      center[0],
      WALL_WIDTH - center[0],
      center[1],
      WALL_HEIGHT - center[1],
    );
    return {
      type: "shape",
      shape: "circle",
      x: center[0],
      y: center[1],
      radius: Math.max(1, radius),
      color,
      width,
    };
  }
  if (kind === "rectangle") {
    return {
      type: "shape",
      shape: "rectangle",
      x: start[0],
      y: start[1],
      rectWidth: end[0] - start[0] || 1,
      rectHeight: end[1] - start[1] || 1,
      color,
      width,
    };
  }
  return {
    type: "shape",
    shape: kind,
    x1: start[0],
    y1: start[1],
    x2: end[0],
    y2: end[1],
    color,
    width,
  };
}

export function wallView(wallHash: string): () => void {
  const app = document.getElementById("app")!;
  app.innerHTML = "";
  app.className = "comp-wall-app wall-room-page";

  let cancelled = false;
  let state: ChannelState | undefined;
  let channel: Channel | undefined = readCachedChannels()?.value.find(
    (candidate) => candidate.hash.toLowerCase() === wallHash.toLowerCase(),
  );
  if ((channel?.kind ?? channelKind(wallHash)) === "chat") {
    location.hash = channelRoute(wallHash, "chat");
    return () => {
      app.className = "";
    };
  }
  let records = recordsFromMessages(readCachedMessages(wallHash, 200)?.value ?? []);
  let draftEvents: GraffitiEvent[] = [];
  let provisionalEvent: GraffitiEvent | undefined;
  let selectedRecord: GraffitiRecord | undefined;
  let activeTool: Tool = "pen";
  let activeShape: ShapeKind = "rectangle";
  let activeColor = COLORS[1];
  let activeWidth = 10;
  let identity: SigningIdentity = anonymousIdentity();
  let walletIdentity: SigningIdentity | undefined;
  let selectingIdentity = false;
  let refreshing = false;
  let posting = false;
  let historicalIndex: number | undefined;
  let replaySpeed: typeof REPLAY_SPEEDS[number] = 4;
  let replayTimer: number | undefined;
  let pollTimer: number | undefined;
  let renderFrame: number | undefined;
  let snapshotCount = 0;
  let snapshotOnly = false;
  let activeSnapshot: WallSnapshot | undefined;
  let livePoints: Point[] = [];
  let drawingPointer: number | undefined;
  let shapeStart: Point | undefined;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchStart: { distance: number; centerX: number; centerY: number; zoom: number; panX: number; panY: number } | undefined;

  const header = el("header", { className: "wall-room-header" });
  const brand = el("a", { href: "#/", className: "wall-brand" });
  brand.appendChild(el("span", { className: "wall-brand-mark", "aria-hidden": "true" }, "C"));
  brand.appendChild(el("span", {}, "COMP SPACES"));
  header.appendChild(brand);
  const wallIdentity = el("div", { className: "room-identity" });
  const wallTitle = el("strong", {}, channel ? shortWallName(channel.name) : "#loading-wall");
  const liveBadge = el("span", { className: "live-badge" }, "● LIVE");
  const markCount = el("span", { className: "mark-count" }, `${records.length} marks`);
  wallIdentity.appendChild(wallTitle);
  wallIdentity.appendChild(liveBadge);
  wallIdentity.appendChild(markCount);
  header.appendChild(wallIdentity);
  header.appendChild(el("span", { className: "wall-spacer" }));
  const refreshButton = el("button", { className: "header-button", type: "button" }, "↻ Refresh") as HTMLButtonElement;
  header.appendChild(refreshButton);
  const activityToggle = el("button", { className: "activity-toggle", type: "button", "aria-label": "Toggle activity" }, "☷") as HTMLButtonElement;
  header.appendChild(activityToggle);
  const sponsorLink = el(
    "a",
    { href: `#/channel/${encodeURIComponent(wallHash)}/add-cell`, className: "sponsor-button" },
    "♥ Sponsor",
  );
  header.appendChild(sponsorLink);
  app.appendChild(header);

  const offlineBanner = el("div", { className: "wall-offline-banner", role: "status" });
  offlineBanner.hidden = true;
  app.appendChild(offlineBanner);

  const workspace = el("div", { className: "wall-workspace" });
  const wallsAside = el("aside", { className: "walls-rail", "aria-label": "Spaces" });
  const wallsHeading = el("div", { className: "rail-heading" }, "SPACES");
  wallsAside.appendChild(wallsHeading);
  const wallsList = el("nav", { className: "walls-mini-list" });
  wallsAside.appendChild(wallsList);
  wallsAside.appendChild(el("a", { href: "#/channels/new", className: "new-wall-link" }, "+ New text room"));
  wallsAside.appendChild(el("a", { href: "#/walls/new", className: "new-wall-link" }, "+ New wall"));
  workspace.appendChild(wallsAside);

  const center = el("main", { className: "wall-center" });
  const canvasHeader = el("div", { className: "canvas-status-row" });
  const modeBadge = el("span", { className: "canvas-mode-badge" }, "NOW · EDITING");
  const cacheStatus = el("span", { className: "canvas-cache-status" }, "Loading saved wall…");
  canvasHeader.appendChild(modeBadge);
  canvasHeader.appendChild(cacheStatus);
  center.appendChild(canvasHeader);

  const viewport = el("div", { className: "wall-viewport" });
  const stage = el("div", { className: "wall-stage" });
  const confirmedCanvas = document.createElement("canvas");
  const pendingCanvas = document.createElement("canvas");
  const draftCanvas = document.createElement("canvas");
  confirmedCanvas.className = "wall-layer confirmed-layer";
  pendingCanvas.className = "wall-layer pending-layer";
  draftCanvas.className = "wall-layer draft-layer";
  confirmedCanvas.setAttribute("aria-hidden", "true");
  pendingCanvas.setAttribute("aria-hidden", "true");
  draftCanvas.setAttribute("role", "img");
  draftCanvas.setAttribute("aria-label", "Collaborative drawing canvas. Use the toolbar or activity list to interact.");
  configureWallCanvas(confirmedCanvas);
  configureWallCanvas(pendingCanvas);
  configureWallCanvas(draftCanvas);
  stage.appendChild(confirmedCanvas);
  stage.appendChild(pendingCanvas);
  stage.appendChild(draftCanvas);
  const wetBadge = el("div", { className: "wet-paint-badge" }, "WET PAINT…");
  wetBadge.hidden = true;
  stage.appendChild(wetBadge);
  const chainBadge = el("div", { className: "on-chain-badge" }, "✓ ON-CHAIN");
  chainBadge.hidden = true;
  stage.appendChild(chainBadge);
  viewport.appendChild(stage);
  center.appendChild(viewport);

  const toolbar = el("div", { className: "drawing-toolbar", role: "toolbar", "aria-label": "Drawing tools" });
  const penButton = toolButton("pen", "✎", "Pen", "P");
  const eraserButton = toolButton("eraser", "◇", "Eraser", "E");
  const textButton = toolButton("text", "T", "Text", "T");
  const shapeButton = toolButton("shape", "▱", "Shape", "S");
  const toolButtons = [penButton, eraserButton, textButton, shapeButton];
  toolButtons.forEach((button) => toolbar.appendChild(button));
  const dividerOne = el("span", { className: "toolbar-divider" });
  toolbar.appendChild(dividerOne);

  const shapeSelect = el("select", { className: "shape-select", "aria-label": "Shape type" }) as HTMLSelectElement;
  ["rectangle", "circle", "line", "arrow"].forEach((shape) => {
    shapeSelect.appendChild(el("option", { value: shape }, shape) as HTMLOptionElement);
  });
  shapeSelect.hidden = true;
  toolbar.appendChild(shapeSelect);

  const palette = el("div", { className: "color-palette", "aria-label": "Colors" });
  const colorButtons: HTMLButtonElement[] = [];
  COLORS.forEach((color) => {
    const button = el(
      "button",
      { className: "color-swatch", type: "button", title: color, "aria-label": `Use color ${color}` },
    ) as HTMLButtonElement;
    button.style.setProperty("--swatch", color);
    button.addEventListener("click", () => {
      activeColor = color;
      updateToolbar();
    });
    colorButtons.push(button);
    palette.appendChild(button);
  });
  toolbar.appendChild(palette);
  const sizeControl = el("label", { className: "size-control" });
  sizeControl.appendChild(el("span", {}, "SIZE"));
  const sizeInput = el("input", {
    type: "range",
    min: "1",
    max: "96",
    value: String(activeWidth),
    "aria-label": "Brush size",
  }) as HTMLInputElement;
  sizeControl.appendChild(sizeInput);
  const sizeValue = el("output", {}, String(activeWidth));
  sizeControl.appendChild(sizeValue);
  toolbar.appendChild(sizeControl);

  const undoButton = el("button", { className: "tool-button undo-button", type: "button", title: "Undo local draft (Ctrl/⌘ Z)" }, "↶ Undo") as HTMLButtonElement;
  toolbar.appendChild(undoButton);
  const identitySelect = el("select", { className: "identity-select", "aria-label": "Post identity" }) as HTMLSelectElement;

  function renderIdentityOptions(): void {
    identitySelect.innerHTML = "";
    identitySelect.appendChild(el("option", { value: "anonymous" }, "👻 Anonymous") as HTMLOptionElement);

    if (walletIdentity && isWalletConnected()) {
      identitySelect.appendChild(
        el("option", { value: "wallet" }, `◈ Wallet · ${walletIdentity.label}`) as HTMLOptionElement,
      );
      identitySelect.appendChild(
        el("option", { value: "disconnect" }, "× Disconnect wallet") as HTMLOptionElement,
      );
    } else {
      identitySelect.appendChild(
        el("option", { value: "connect" }, "⌁ Connect wallet…") as HTMLOptionElement,
      );
    }

    identitySelect.value = identity.mode === "wallet" && walletIdentity
      ? "wallet"
      : "anonymous";
  }

  renderIdentityOptions();
  toolbar.appendChild(identitySelect);
  const postButton = el("button", { className: "post-paint-button", type: "button" }, "POST 0") as HTMLButtonElement;
  toolbar.appendChild(postButton);
  center.appendChild(toolbar);

  const timeline = el("section", { className: "time-machine" });
  const timelineHeading = el("div", { className: "time-machine-heading" });
  timelineHeading.appendChild(el("strong", {}, "TIME MACHINE"));
  const historicalLabel = el("span", { className: "historical-label" }, "NOW");
  timelineHeading.appendChild(historicalLabel);
  timeline.appendChild(timelineHeading);
  const timelineControls = el("div", { className: "timeline-controls" });
  const playButton = el("button", { className: "timeline-play", type: "button", title: "Replay wall" }, "▶") as HTMLButtonElement;
  const speedButton = el("button", { className: "timeline-speed", type: "button" }, `${replaySpeed}×`) as HTMLButtonElement;
  const timelineInput = el("input", { type: "range", min: "0", max: "0", value: "0", "aria-label": "Wall history position" }) as HTMLInputElement;
  const nowButton = el("button", { className: "timeline-now", type: "button" }, "NOW") as HTMLButtonElement;
  timelineControls.appendChild(playButton);
  timelineControls.appendChild(speedButton);
  timelineControls.appendChild(timelineInput);
  timelineControls.appendChild(nowButton);
  timeline.appendChild(timelineControls);
  center.appendChild(timeline);
  workspace.appendChild(center);

  const activityAside = el("aside", { className: "activity-rail", "aria-label": "Recent activity" });
  const activityHeading = el("div", { className: "rail-heading" });
  activityHeading.appendChild(el("span", {}, "ACTIVITY"));
  const activityDot = el("span", { className: "activity-dot" }, "●");
  activityHeading.appendChild(activityDot);
  activityAside.appendChild(activityHeading);
  const activityList = el("div", { className: "activity-list" });
  activityAside.appendChild(activityList);
  const supplyCard = el("div", { className: "paint-supply-card" });
  activityAside.appendChild(supplyCard);
  workspace.appendChild(activityAside);
  app.appendChild(workspace);

  const detail = el("aside", { className: "graffiti-detail", "aria-live": "polite" });
  detail.hidden = true;
  app.appendChild(detail);

  const textDialog = document.createElement("dialog");
  textDialog.className = "wall-text-dialog";
  const textForm = el("form", { method: "dialog" });
  textForm.appendChild(el("span", { className: "eyebrow" }, "WRITE ON THE WALL"));
  textForm.appendChild(el("h2", {}, "Say it out loud."));
  const textInput = el("input", { type: "text", maxlength: "280", placeholder: "GM CKB!", autocomplete: "off" }) as HTMLInputElement;
  textForm.appendChild(textInput);
  const textActions = el("div", { className: "dialog-actions" });
  const textCancel = el("button", { type: "button", className: "outline-button" }, "Cancel") as HTMLButtonElement;
  const textAdd = el("button", { type: "submit", className: "ink-button" }, "Add text") as HTMLButtonElement;
  textActions.appendChild(textCancel);
  textActions.appendChild(textAdd);
  textForm.appendChild(textActions);
  textDialog.appendChild(textForm);
  app.appendChild(textDialog);
  let textPoint: Point | undefined;

  function renderWallsList(): void {
    wallsList.innerHTML = "";
    const channels = readCachedChannels()?.value ?? (channel ? [channel] : []);
    for (const item of channels) {
      const cachedMessages = readCachedMessages(item.hash, 200)?.value ?? [];
      const itemRecords = recordsFromMessages(cachedMessages);
      const kind = item.kind ?? (itemRecords.length > 0 ? "wall" : cachedMessages.length > 0 ? "chat" : "wall");
      const link = el("a", {
        href: channelRoute(item.hash, kind),
        className: item.hash.toLowerCase() === wallHash.toLowerCase() ? "is-active" : "",
      });
      link.appendChild(el("span", { className: `mini-wall-thumb ${kind === "chat" ? "is-chat" : ""}` }, kind === "chat" ? "Aa" : item.name.slice(0, 1).toUpperCase()));
      const copy = el("span", {});
      copy.appendChild(el("strong", {}, shortWallName(item.name)));
      copy.appendChild(el("small", {}, kind === "chat" ? `${cachedMessages.length} messages` : `${itemRecords.length} marks`));
      link.appendChild(copy);
      wallsList.appendChild(link);
    }
  }

  function confirmedRecords(): GraffitiRecord[] {
    return records.filter((record) => record.status === "confirmed");
  }

  function pendingRecords(): GraffitiRecord[] {
    return records.filter((record) => record.status === "pending");
  }

  function scheduleRender(): void {
    if (renderFrame !== undefined) cancelAnimationFrame(renderFrame);
    renderFrame = requestAnimationFrame(() => {
      renderFrame = undefined;
      renderCanvas();
    });
  }

  function renderCanvas(): void {
    if (snapshotOnly && records.length === 0 && draftEvents.length === 0 && !provisionalEvent) {
      confirmedCanvas.style.opacity = "1";
      pendingCanvas.style.opacity = "0";
      draftCanvas.style.opacity = "0";
      return;
    }
    const confirmed = confirmedRecords();
    const shownConfirmed = historicalIndex === undefined ? confirmed : confirmed.slice(0, historicalIndex);
    const atNow = historicalIndex === undefined;
    const pending = atNow ? pendingRecords() : [];
    const local = atNow ? [...draftEvents, ...(provisionalEvent ? [provisionalEvent] : [])] : [];
    const visibleRecords = [...shownConfirmed, ...pending];
    const selection = selectedRecord && visibleRecords.some((record) => record.eventId === selectedRecord?.eventId)
      ? selectedRecord.event
      : undefined;

    renderEventSequence(confirmedCanvas, shownConfirmed.map((record) => record.event));
    renderEventSequence(pendingCanvas, pending.map((record) => record.event), confirmedCanvas, 0.68);
    const base = pending.length > 0 ? pendingCanvas : confirmedCanvas;
    renderEventSequence(draftCanvas, local, base, 1, selection);

    confirmedCanvas.style.opacity = local.length || selection || pending.length ? "0" : "1";
    pendingCanvas.style.opacity = !local.length && !selection && pending.length ? "1" : "0";
    draftCanvas.style.opacity = local.length || selection ? "1" : "0";
    wetBadge.hidden = pending.length === 0;
    stage.classList.toggle("has-wet-paint", pending.length > 0);
    draftCanvas.style.cursor = historicalIndex === undefined
      ? activeTool === "text" ? "text" : "crosshair"
      : "not-allowed";
  }

  function renderHeader(): void {
    if (channel) wallTitle.textContent = shortWallName(channel.name);
    markCount.textContent = `${records.length.toLocaleString()} marks`;
    refreshButton.textContent = refreshing ? "↻ Checking…" : "↻ Refresh";
    refreshButton.disabled = refreshing;
    liveBadge.textContent = offlineBanner.hidden ? "● LIVE" : "○ SAVED";
    liveBadge.classList.toggle("is-offline", !offlineBanner.hidden);
  }

  function renderSupply(): void {
    supplyCard.innerHTML = "";
    supplyCard.appendChild(el("div", { className: "supply-title" }, "PAINT SUPPLY"));
    if (!channel) {
      supplyCard.appendChild(el("p", {}, "Checking capacity…"));
      return;
    }
    const reserved = MIN_CELL_CAPACITY * BigInt(channel.cells.length);
    const usable = channel.totalCapacity > reserved ? channel.totalCapacity - reserved : 0n;
    const estimateFee = MESSAGE_FEE_RATE * 400n;
    const estimatedPosts = estimateFee > 0n ? usable / estimateFee : 0n;
    supplyCard.appendChild(el("strong", { className: "supply-value" }, formatCapacity(usable)));
    supplyCard.appendChild(el("span", { className: "supply-posts" }, `~${estimatedPosts.toLocaleString()} posts`));
    const meter = el("div", { className: "supply-meter" });
    const fill = el("span", {});
    const nominal = 100n * 10n ** 8n;
    const percentage = Number(usable > nominal ? 100n : (usable * 100n) / nominal);
    fill.style.width = `${Math.max(3, percentage)}%`;
    meter.appendChild(fill);
    supplyCard.appendChild(meter);
    supplyCard.appendChild(el("a", { href: `#/channel/${encodeURIComponent(wallHash)}/add-cell` }, "♥ Buy paint for everyone"));
  }

  function renderActivity(): void {
    activityList.innerHTML = "";
    const grouped = new Map<string, GraffitiRecord[]>();
    for (const record of records) {
      const group = grouped.get(record.txHash) ?? [];
      group.push(record);
      grouped.set(record.txHash, group);
    }
    const latest = Array.from(grouped.values()).reverse().slice(0, 80);
    if (latest.length === 0) {
      activityList.appendChild(el("div", { className: "activity-empty" }, "No marks yet. Be the first."));
      return;
    }
    for (const batch of latest) {
      const record = batch[batch.length - 1];
      const button = el("button", {
        className: `activity-item ${record.status === "pending" ? "is-pending" : ""}`,
        type: "button",
        "aria-label": `${formatGraffitiAuthor(record)} ${eventSummary(record.event)}`,
      }) as HTMLButtonElement;
      const author = el("div", { className: "activity-author" });
      author.appendChild(el("span", { className: "author-avatar" }, record.signed ? "✓" : "👻"));
      author.appendChild(el("strong", { title: record.author }, record.signed ? truncateHash(record.author, 5, 4) : "Anonymous"));
      author.appendChild(el("time", {}, record.status === "pending" ? "Wet" : relativeTime(record.timestamp)));
      button.appendChild(author);
      button.appendChild(el("span", { className: "activity-action" }, eventSummary(record.event, batch.length)));
      button.addEventListener("click", () => selectRecord(record));
      activityList.appendChild(button);
    }
  }

  function renderTimeline(): void {
    const confirmed = confirmedRecords();
    timelineInput.max = String(confirmed.length);
    timelineInput.value = String(historicalIndex ?? confirmed.length);
    const index = historicalIndex ?? confirmed.length;
    historicalLabel.textContent = historicalIndex === undefined
      ? `NOW · ${confirmed.length.toLocaleString()} ON-CHAIN MARKS`
      : index === 0 ? "EMPTY WALL" : `MARK ${index.toLocaleString()} / ${confirmed.length.toLocaleString()}`;
    modeBadge.textContent = historicalIndex === undefined ? "NOW · EDITING" : "HISTORICAL MODE · READ ONLY";
    modeBadge.classList.toggle("is-history", historicalIndex !== undefined);
    nowButton.disabled = historicalIndex === undefined;
    postButton.disabled = posting || draftEvents.length === 0 || historicalIndex !== undefined;
    toolButtons.forEach((button) => { button.disabled = historicalIndex !== undefined; });
  }

  function renderComposerState(): void {
    postButton.textContent = posting ? "PREPARING…" : selectingIdentity ? "CONNECTING…" : `POST ${draftEvents.length}`;
    postButton.disabled = posting || selectingIdentity || draftEvents.length === 0 || historicalIndex !== undefined;
    undoButton.disabled = draftEvents.length === 0 || posting || historicalIndex !== undefined;
    identitySelect.disabled = posting || selectingIdentity;
    cacheStatus.textContent = draftEvents.length
      ? `${draftEvents.length} local ${draftEvents.length === 1 ? "mark" : "marks"} · draft saved`
      : refreshing ? "Checking CKB…" : "Chain + local cache synced";
  }

  function renderAll(): void {
    renderHeader();
    renderWallsList();
    renderSupply();
    renderActivity();
    renderTimeline();
    renderComposerState();
    scheduleRender();
  }

  function updateToolbar(): void {
    toolButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.tool === activeTool));
    colorButtons.forEach((button, index) => button.classList.toggle("is-active", COLORS[index] === activeColor));
    shapeSelect.hidden = activeTool !== "shape";
  }

  function persistDraft(): void {
    void saveWallDraft(wallHash, draftEvents);
  }

  function commitDraftEvent(event: GraffitiEvent): void {
    draftEvents.push(event);
    provisionalEvent = undefined;
    persistDraft();
    renderComposerState();
    scheduleRender();
  }

  function selectRecord(record: GraffitiRecord): void {
    activityAside.classList.remove("is-open");
    selectedRecord = record;
    detail.hidden = false;
    detail.innerHTML = "";
    const close = el("button", { className: "detail-close", type: "button", "aria-label": "Close details" }, "×") as HTMLButtonElement;
    close.addEventListener("click", () => {
      selectedRecord = undefined;
      detail.hidden = true;
      scheduleRender();
    });
    detail.appendChild(close);
    detail.appendChild(el("span", { className: `detail-status ${record.status}` }, record.status === "pending" ? "WET PAINT" : "ON-CHAIN"));
    detail.appendChild(el("h3", {}, eventSummary(record.event)));
    detail.appendChild(el("p", { className: "detail-author", title: record.author }, formatGraffitiAuthor(record)));
    const meta = el("dl", {});
    meta.appendChild(el("dt", {}, "When"));
    meta.appendChild(el("dd", {}, record.status === "pending" ? "Pending" : relativeTime(record.timestamp)));
    meta.appendChild(el("dt", {}, "Block"));
    meta.appendChild(el("dd", {}, record.blockNumber === undefined ? "—" : record.blockNumber.toLocaleString()));
    meta.appendChild(el("dt", {}, "Event ID"));
    meta.appendChild(el("dd", { className: "detail-code" }, record.eventId));
    detail.appendChild(meta);
    detail.appendChild(el("a", { href: `${EXPLORER_TX_URL}${record.txHash}`, target: "_blank", rel: "noreferrer" }, "View on CKB Explorer ↗"));
    if (record.status === "confirmed") {
      const viewThen = el("button", { className: "outline-button detail-history", type: "button" }, "View when posted") as HTMLButtonElement;
      viewThen.addEventListener("click", () => {
        const index = confirmedRecords().findIndex((candidate) => candidate.eventId === record.eventId);
        if (index >= 0) {
          historicalIndex = index + 1;
          stopReplay();
          renderAll();
        }
      });
      detail.appendChild(viewThen);
    }
    scheduleRender();
  }

  function flashOnChain(): void {
    chainBadge.hidden = false;
    window.setTimeout(() => { chainBadge.hidden = true; }, 2200);
  }

  async function refresh(): Promise<void> {
    if (cancelled || refreshing) return;
    refreshing = true;
    offlineBanner.hidden = true;
    renderAll();
    try {
      const next = await resolveChannelState(wallHash, 500);
      if (cancelled) return;
      const hadPending = pendingRecords().length > 0;
      state = next;
      channel = next.channel;
      const chainRecords = recordsFromMessages([...next.confirmed, ...next.pending]);
      records = reconcileConfirmedHistory(records, chainRecords, next.confirmed);
      snapshotOnly = false;
      if (activeSnapshot) {
        const checkpoint = records.find((record) => record.eventId === activeSnapshot?.eventId);
        const mismatch = !checkpoint ||
          checkpoint.blockNumber?.toString() !== activeSnapshot.blockNumber ||
          (activeSnapshot.blockHash !== undefined && checkpoint.blockHash !== activeSnapshot.blockHash);
        if (mismatch) {
          await clearWallSnapshot(wallHash);
          activeSnapshot = undefined;
          snapshotCount = 0;
        }
      }
      await saveWallRecords(wallHash, records.filter((record) => record.status === "confirmed"));
      const persistedPending = await readPendingWallPosts(wallHash);
      const confirmedTx = new Set(next.confirmed.map((message) => message.txHash));
      for (const pending of persistedPending) {
        if (confirmedTx.has(pending.txHash)) await removePendingWallPost(pending.txHash);
      }
      if (hadPending && pendingRecords().length === 0) flashOnChain();
      await checkpointSnapshot();
    } catch (error) {
      if (cancelled) return;
      offlineBanner.hidden = false;
      offlineBanner.textContent = records.length
        ? "Showing the last saved wall. Chain updates are temporarily unavailable."
        : "The chain is temporarily unavailable. Your local draft is safe.";
      toast(error instanceof Error ? error.message : String(error), "err");
    } finally {
      refreshing = false;
      renderAll();
      schedulePendingPoll();
    }
  }

  async function checkpointSnapshot(): Promise<void> {
    const confirmed = confirmedRecords();
    if (confirmed.length === 0 || (snapshotCount > 0 && confirmed.length - snapshotCount < 50)) return;
    renderEventSequence(confirmedCanvas, confirmed.map((record) => record.event));
    const last = confirmed[confirmed.length - 1];
    const image = await canvasToBlob(confirmedCanvas);
    activeSnapshot = {
      wallHash,
      eventCount: confirmed.length,
      eventId: last.eventId,
      blockNumber: last.blockNumber?.toString(),
      blockHash: last.blockHash,
      createdAt: Date.now(),
      image,
    };
    await saveWallSnapshot(activeSnapshot);
    snapshotCount = confirmed.length;
  }

  function schedulePendingPoll(): void {
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = undefined;
    if (cancelled || pendingRecords().length === 0) return;
    pollTimer = window.setTimeout(() => void pollPending(), PENDING_POLL_INTERVAL_MS);
  }

  async function pollPending(): Promise<void> {
    if (cancelled) return;
    try {
      const messages = await loadPendingMessages(wallHash);
      const stillPending = new Set(messages.map((message) => message.txHash));
      const persisted = await readPendingWallPosts(wallHash);
      for (const pending of persisted) {
        if (!stillPending.has(pending.txHash)) await removePendingWallPost(pending.txHash);
      }
      records = records.filter((record) => record.status === "confirmed" || stillPending.has(record.txHash));
      records = mergeGraffitiRecords(records, recordsFromMessages(messages));
      if (messages.length === 0) {
        await refresh();
        return;
      }
      renderAll();
    } catch (error) {
      console.error("COMP Wall pending poll", error);
    }
    schedulePendingPoll();
  }

  async function postDraft(): Promise<void> {
    if (posting || draftEvents.length === 0 || historicalIndex !== undefined) return;
    posting = true;
    renderComposerState();
    try {
      const payload = serializeGraffitiBatch(draftEvents);
      const postedEvents = [...draftEvents];
      const postingIdentity = identity;
      const txHash = postingIdentity.mode === "anonymous"
        ? await postAnonymous(wallHash, payload)
        : await postSigned(wallHash, payload, postingIdentity);
      const submittedAt = Date.now();
      await savePendingWallPost({
        txHash,
        wallHash,
        payload,
        author: postingIdentity.publicKey ?? postingIdentity.label,
        submittedAt,
      });
      trackPendingTx(txHash, wallHash, submittedAt);
      const pendingMessage: Message = {
        txHash,
        status: "pending",
        author: postingIdentity.mode === "anonymous"
          ? "Anonymous"
          : postingIdentity.publicKey ?? postingIdentity.label,
        payload,
        compInputIndex: 0,
      };
      records = mergeGraffitiRecords(records, recordsFromMessages([pendingMessage], submittedAt));
      draftEvents = [];
      provisionalEvent = undefined;
      await saveWallDraft(wallHash, []);
      toast(`${postedEvents.length} ${postedEvents.length === 1 ? "mark" : "marks"} submitted · Wet Paint`, "ok");
      renderAll();
      schedulePendingPoll();
    } catch (error) {
      toast(`Your draft is safe · ${error instanceof Error ? error.message : String(error)}`, "err");
    } finally {
      posting = false;
      renderComposerState();
    }
  }

  function stopReplay(): void {
    if (replayTimer !== undefined) clearTimeout(replayTimer);
    replayTimer = undefined;
    playButton.textContent = "▶";
  }

  function replayStep(): void {
    const total = confirmedRecords().length;
    const current = historicalIndex ?? total;
    const step = replaySpeed >= 16 ? replaySpeed / 4 : 1;
    const next = Math.min(total, current + step);
    historicalIndex = next >= total ? undefined : next;
    renderAll();
    if (next >= total) {
      stopReplay();
      return;
    }
    const delay = replaySpeed === 1 ? 420 : replaySpeed === 4 ? 110 : 80;
    replayTimer = window.setTimeout(replayStep, delay);
  }

  function startReplay(): void {
    if (replayTimer !== undefined) {
      stopReplay();
      return;
    }
    if (historicalIndex === undefined || historicalIndex >= confirmedRecords().length) historicalIndex = 0;
    playButton.textContent = "Ⅱ";
    renderAll();
    replayTimer = window.setTimeout(replayStep, 200);
  }

  function applyViewport(): void {
    stage.style.width = `${zoom * 100}%`;
    stage.style.transform = `translate(${panX}px, ${panY}px)`;
  }

  function pointerDistance(): { distance: number; centerX: number; centerY: number } | undefined {
    const [first, second] = Array.from(pointers.values());
    if (!first || !second) return;
    return {
      distance: Math.hypot(second.x - first.x, second.y - first.y),
      centerX: (first.x + second.x) / 2,
      centerY: (first.y + second.y) / 2,
    };
  }

  function cancelProvisional(): void {
    drawingPointer = undefined;
    livePoints = [];
    shapeStart = undefined;
    provisionalEvent = undefined;
    scheduleRender();
  }

  draftCanvas.addEventListener("pointerdown", (event) => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    draftCanvas.setPointerCapture(event.pointerId);
    if (pointers.size === 2) {
      cancelProvisional();
      const gesture = pointerDistance();
      if (gesture) pinchStart = { ...gesture, zoom, panX, panY };
      return;
    }
    if (historicalIndex !== undefined || pointers.size > 1) return;
    const point = canvasPoint(draftCanvas, event.clientX, event.clientY);
    if (activeTool === "text") {
      textPoint = point;
      textInput.value = "";
      textDialog.showModal();
      window.setTimeout(() => textInput.focus(), 0);
      return;
    }
    drawingPointer = event.pointerId;
    if (activeTool === "shape") {
      shapeStart = point;
      provisionalEvent = shapeFromDrag(activeShape, point, point, activeColor, activeWidth);
    } else {
      livePoints = [point, point];
      provisionalEvent = activeTool === "eraser"
        ? { type: "erase", points: livePoints, width: activeWidth * 2 }
        : { type: "stroke", points: livePoints, color: activeColor, width: activeWidth };
    }
    scheduleRender();
  });

  draftCanvas.addEventListener("pointermove", (event) => {
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size >= 2 && pinchStart) {
      const gesture = pointerDistance();
      if (!gesture) return;
      zoom = Math.max(1, Math.min(4, pinchStart.zoom * (gesture.distance / Math.max(1, pinchStart.distance))));
      panX = pinchStart.panX + gesture.centerX - pinchStart.centerX;
      panY = pinchStart.panY + gesture.centerY - pinchStart.centerY;
      applyViewport();
      return;
    }
    if (drawingPointer !== event.pointerId || historicalIndex !== undefined) return;
    const point = canvasPoint(draftCanvas, event.clientX, event.clientY);
    if (activeTool === "shape" && shapeStart) {
      provisionalEvent = shapeFromDrag(activeShape, shapeStart, point, activeColor, activeWidth);
    } else if (activeTool === "pen" || activeTool === "eraser") {
      const previous = livePoints[livePoints.length - 1];
      if (Math.hypot(point[0] - previous[0], point[1] - previous[1]) >= 2) livePoints.push(point);
      provisionalEvent = activeTool === "eraser"
        ? { type: "erase", points: livePoints, width: Math.min(96, activeWidth * 2) }
        : { type: "stroke", points: livePoints, color: activeColor, width: activeWidth };
    }
    scheduleRender();
  });

  function endPointer(event: PointerEvent): void {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchStart = undefined;
    if (drawingPointer !== event.pointerId || !provisionalEvent) return;
    let eventToCommit = provisionalEvent;
    if (eventToCommit.type === "stroke" || eventToCommit.type === "erase") {
      const simplified = simplifyPoints(eventToCommit.points);
      eventToCommit = eventToCommit.type === "stroke"
        ? { ...eventToCommit, points: simplified }
        : { ...eventToCommit, points: simplified };
    }
    cancelProvisional();
    commitDraftEvent(eventToCommit);
  }

  draftCanvas.addEventListener("pointerup", endPointer);
  draftCanvas.addEventListener("pointercancel", (event) => {
    pointers.delete(event.pointerId);
    cancelProvisional();
  });

  viewport.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoom = Math.max(1, Math.min(4, zoom * (event.deltaY > 0 ? 0.9 : 1.1)));
    if (zoom === 1) {
      panX = 0;
      panY = 0;
    }
    applyViewport();
  }, { passive: false });

  toolButtons.forEach((button) => {
    button.addEventListener("click", () => {
      activeTool = button.dataset.tool as Tool;
      updateToolbar();
    });
  });
  shapeSelect.addEventListener("change", () => { activeShape = shapeSelect.value as ShapeKind; });
  sizeInput.addEventListener("input", () => {
    activeWidth = Number(sizeInput.value);
    sizeValue.textContent = sizeInput.value;
  });
  undoButton.addEventListener("click", () => {
    draftEvents.pop();
    persistDraft();
    renderAll();
  });
  identitySelect.addEventListener("change", async () => {
    if (selectingIdentity) return;
    selectingIdentity = true;
    renderComposerState();
    try {
      if (identitySelect.value === "connect") {
        const connected = await connectWallet("message", false);
        if (connected?.mode === "wallet") {
          walletIdentity = connected;
          identity = connected;
          toast(`Wallet selected · ${connected.label}`, "ok");
        } else {
          identity = anonymousIdentity();
        }
      } else if (identitySelect.value === "wallet") {
        identity = walletIdentity ?? anonymousIdentity();
      } else if (identitySelect.value === "disconnect") {
        disconnectWallet();
        walletIdentity = undefined;
        identity = anonymousIdentity();
        toast("Wallet disconnected · posting anonymously", "ok");
      } else {
        identity = anonymousIdentity();
      }
    } finally {
      selectingIdentity = false;
      renderIdentityOptions();
      renderComposerState();
    }
  });
  postButton.addEventListener("click", () => void postDraft());
  refreshButton.addEventListener("click", () => void refresh());
  activityToggle.addEventListener("click", () => activityAside.classList.toggle("is-open"));
  timelineInput.addEventListener("input", () => {
    stopReplay();
    const next = Number(timelineInput.value);
    historicalIndex = next >= confirmedRecords().length ? undefined : next;
    selectedRecord = undefined;
    detail.hidden = true;
    renderAll();
  });
  nowButton.addEventListener("click", () => {
    stopReplay();
    historicalIndex = undefined;
    renderAll();
  });
  playButton.addEventListener("click", startReplay);
  speedButton.addEventListener("click", () => {
    const index = REPLAY_SPEEDS.indexOf(replaySpeed);
    replaySpeed = REPLAY_SPEEDS[(index + 1) % REPLAY_SPEEDS.length];
    speedButton.textContent = `${replaySpeed}×`;
  });
  textCancel.addEventListener("click", () => textDialog.close());
  textForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = textInput.value.trim();
    if (text && textPoint) {
      commitDraftEvent({
        type: "text",
        x: textPoint[0],
        y: textPoint[1],
        text,
        color: activeColor,
        size: Math.max(18, activeWidth * 4),
      });
    }
    textDialog.close();
  });

  const keyHandler = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target?.matches("input, textarea, select") || textDialog.open) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undoButton.click();
    } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void postDraft();
    } else if (!event.metaKey && !event.ctrlKey) {
      const tool = ({ p: "pen", e: "eraser", t: "text", s: "shape" } as Record<string, Tool>)[event.key.toLowerCase()];
      if (tool) {
        activeTool = tool;
        updateToolbar();
      }
    }
  };
  window.addEventListener("keydown", keyHandler);

  async function hydrate(): Promise<void> {
    try {
      const [cachedState, savedDraft, savedPending, snapshot] = await Promise.all([
        readWallRecords(wallHash),
        readWallDraft(wallHash),
        readPendingWallPosts(wallHash),
        readWallSnapshot(wallHash),
      ]);
      if (cancelled) return;
      if (snapshot) {
        activeSnapshot = snapshot;
        snapshotCount = snapshot.eventCount;
        if (cachedState) {
          const checkpoint = cachedState.records.find((record) => record.eventId === snapshot.eventId);
          const mismatch = !checkpoint ||
            checkpoint.blockNumber?.toString() !== snapshot.blockNumber ||
            (snapshot.blockHash !== undefined && checkpoint.blockHash !== snapshot.blockHash);
          if (mismatch) {
            await clearWallSnapshot(wallHash);
            activeSnapshot = undefined;
            snapshotCount = 0;
          }
        }
        if (activeSnapshot && records.length === 0) {
          await drawSnapshotBlob(confirmedCanvas, snapshot.image);
          snapshotOnly = true;
        }
      }
      if (cachedState) records = mergeGraffitiRecords(records, cachedState.records);
      draftEvents = savedDraft;
      for (const pending of savedPending) {
        trackPendingTx(pending.txHash, wallHash, pending.submittedAt);
        const message: Message = {
          txHash: pending.txHash,
          status: "pending",
          author: pending.author,
          payload: pending.payload,
          compInputIndex: 0,
        };
        records = mergeGraffitiRecords(records, recordsFromMessages([message], pending.submittedAt));
      }
      renderAll();
      await refresh();
    } catch (error) {
      toast(`Local cache recovery skipped: ${error instanceof Error ? error.message : String(error)}`, "err");
      await refresh();
    }
  }

  updateToolbar();
  renderAll();
  void hydrate();

  return () => {
    cancelled = true;
    stopReplay();
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    if (renderFrame !== undefined) cancelAnimationFrame(renderFrame);
    window.removeEventListener("keydown", keyHandler);
    textDialog.remove();
    app.className = "";
  };
}
