import {
  MAX_EVENTS_PER_POST,
  mergeGraffitiRecords,
  recordsFromMessages,
  validateGraffitiEvent,
  type GraffitiEvent,
} from "../compWall";
import {
  describeAiEvent,
  generateAiArtwork,
  type AiArtStyle,
  type AiArtworkPlan,
  type AiPlacement,
} from "../aiWall";
import { discoverChannels } from "../resolver";
import { readCachedChannels, readCachedMessages } from "../scanCache";
import type { Channel } from "../types";
import { configureWallCanvas, renderEventSequence } from "../wallCanvas";
import { readWallDraft, readWallRecords, saveWallDraft } from "../wallCache";
import { navigate } from "../router";
import { el, toast } from "./common";

const STARTER_PROMPT = "在画布空白处画一枚飞向月球的彩色火箭，加上闪烁的星星";
const ARTIST_SKILL_INSTALL_COMMAND = [
  'tmp="$(mktemp -d)"',
  'unzip -q "$HOME/Downloads/comp-wall-artist-skill.zip" -d "$tmp"',
  'mkdir -p "$HOME/.agents/skills/comp-wall-artist" "$HOME/.claude/skills/comp-wall-artist"',
  'cp -R "$tmp/comp-wall-artist/." "$HOME/.agents/skills/comp-wall-artist/"',
  'cp -R "$tmp/comp-wall-artist/." "$HOME/.claude/skills/comp-wall-artist/"',
  'rm -rf "$tmp"',
].join(" && ");

const PROMPT_PRESETS = [
  ["🚀", "月球任务", STARTER_PROMPT],
  ["🤖", "AI 伙伴", "画一个友好的 AI 机器人，胸口写着 “AI”"],
  ["✿", "共享花园", "画一座明亮的社区花园，有花朵、太阳和生长的线条"],
  ["≈", "链上信号", "用大胆的彩色曲线画一组开放、流动的链上信号"],
] as const;

function aiHeader(): HTMLElement {
  const header = el("header", { className: "ai-studio-header" });
  const brand = el("a", { href: "#/", className: "wall-brand" });
  brand.appendChild(el("span", { className: "wall-brand-mark", "aria-hidden": "true" }, "C"));
  brand.appendChild(el("span", {}, "COMP WALL"));
  header.appendChild(brand);
  header.appendChild(el("span", { className: "ai-header-slash" }, "/"));
  header.appendChild(el("strong", { className: "ai-header-title" }, "AI STUDIO"));
  header.appendChild(el("span", { className: "wall-spacer" }));
  header.appendChild(el("span", { className: "ai-agent-ready" }, "● AGENT READY"));
  header.appendChild(el("a", { href: "#/", className: "outline-button ai-header-link" }, "Explore walls ↗"));
  return header;
}

function option(value: string, label: string): HTMLOptionElement {
  return el("option", { value }, label) as HTMLOptionElement;
}

function uniqueChannels(channels: Channel[]): Channel[] {
  return Array.from(new Map(channels.map((channel) => [channel.hash.toLowerCase(), channel])).values());
}

async function copyToClipboard(value: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast(`${label} copied`, "ok");
  } catch {
    toast("Copy failed. Select the command manually.", "err");
  }
}

function parseExactEvents(value: string): GraffitiEvent[] {
  const decoded = JSON.parse(value) as unknown;
  let candidates: unknown[];
  if (Array.isArray(decoded)) {
    candidates = decoded;
  } else if (decoded && typeof decoded === "object" && "events" in decoded && Array.isArray(decoded.events)) {
    candidates = decoded.events;
  } else {
    candidates = [decoded];
  }
  if (candidates.length < 1 || candidates.length > MAX_EVENTS_PER_POST) {
    throw new Error(`Use 1–${MAX_EVENTS_PER_POST} wall events.`);
  }
  const events = candidates.map(validateGraffitiEvent);
  if (events.some((event) => !event)) throw new Error("One or more events do not match the COMP Wall event schema.");
  return events as GraffitiEvent[];
}

export function aiSkillView(): () => void {
  const app = document.getElementById("app")!;
  app.innerHTML = "";
  app.className = "comp-wall-app ai-studio-app";
  app.appendChild(aiHeader());

  let cancelled = false;
  let channels = uniqueChannels(readCachedChannels()?.value ?? []);
  const initialQuery = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const requestedWallHash = initialQuery.get("wall") ?? "";
  let selectedHash = channels.find((channel) => channel.hash.toLowerCase() === requestedWallHash.toLowerCase())?.hash ??
    channels[0]?.hash ?? requestedWallHash;
  let baseEvents: GraffitiEvent[] = [];
  let savedDraft: GraffitiEvent[] = [];
  let plan: AiArtworkPlan | undefined;
  let variation = 0;

  const main = el("main", { className: "ai-studio-main" });
  const hero = el("section", { className: "ai-command-panel" });
  const heroNumber = el("span", { className: "ai-section-number" }, "01 / INSTALL THE ARTIST");
  hero.appendChild(heroNumber);
  hero.appendChild(el("h1", {}, "ONE CLICK. AI DRAWS THE WALL."));
  hero.appendChild(
    el(
      "p",
      { className: "ai-lede" },
      "Install one Agent Skill for local Codex and Claude. Then give it a Wall and an idea—the agent opens AI Studio, reviews the marks, stages them, and posts the painting.",
    ),
  );

  const skillDock = el("section", { className: "ai-skill-dock", "aria-label": "COMP Wall Artist skill" });
  const skillDockTop = el("div", { className: "ai-skill-dock-top" });
  const skillDockCopy = el("div", {});
  skillDockCopy.appendChild(el("span", {}, "CODEX + CLAUDE"));
  skillDockCopy.appendChild(el("strong", {}, "$comp-wall-artist"));
  skillDockTop.appendChild(skillDockCopy);
  skillDockTop.appendChild(el("span", { className: "ai-skill-version" }, "AGENT SKILL · V1"));
  skillDock.appendChild(skillDockTop);
  const skillDownload = el(
    "a",
    {
      className: "ai-skill-download",
      href: new URL("downloads/comp-wall-artist-skill.zip", document.baseURI).toString(),
      download: "comp-wall-artist-skill.zip",
    },
    "↓ DOWNLOAD DRAWING SKILL",
  );
  skillDock.appendChild(skillDownload);
  const skillDockActions = el("div", { className: "ai-skill-dock-actions" });
  const copyInstallButton = el("button", { type: "button" }, "1 · COPY INSTALL COMMAND") as HTMLButtonElement;
  const copyDrawButton = el("button", { type: "button" }, "2 · COPY ONE-CLICK DRAW PROMPT") as HTMLButtonElement;
  skillDockActions.appendChild(copyInstallButton);
  skillDockActions.appendChild(copyDrawButton);
  skillDock.appendChild(skillDockActions);
  skillDock.appendChild(el("p", {}, "Install once into ~/.agents/skills and ~/.claude/skills. The same $skill trigger works in both local agents."));
  hero.appendChild(skillDock);

  const presetRail = el("div", { className: "ai-preset-rail", "aria-label": "Prompt presets" });
  hero.appendChild(presetRail);

  const promptLabel = el("label", { for: "ai-art-prompt", className: "ai-input-label" });
  promptLabel.appendChild(el("span", {}, "CREATIVE BRIEF"));
  promptLabel.appendChild(el("small", {}, "Natural language · 中文 / English"));
  hero.appendChild(promptLabel);
  const promptInput = el("textarea", {
    id: "ai-art-prompt",
    className: "ai-prompt-input",
    rows: "5",
    maxlength: "500",
    "aria-label": "AI art prompt",
    placeholder: "描述画什么、画在哪里、使用什么颜色……",
  }) as HTMLTextAreaElement;
  promptInput.value = STARTER_PROMPT;
  hero.appendChild(promptInput);

  const controlGrid = el("div", { className: "ai-control-grid" });
  const wallControl = el("label", { className: "ai-control" });
  wallControl.appendChild(el("span", {}, "TARGET WALL"));
  const wallSelect = el("select", { "aria-label": "Target wall", "data-testid": "ai-wall-select" }) as HTMLSelectElement;
  wallControl.appendChild(wallSelect);
  controlGrid.appendChild(wallControl);

  const styleControl = el("label", { className: "ai-control" });
  styleControl.appendChild(el("span", {}, "MARK STYLE"));
  const styleSelect = el("select", { "aria-label": "AI art style" }) as HTMLSelectElement;
  styleSelect.appendChild(option("marker", "Community marker"));
  styleSelect.appendChild(option("neon", "Electric neon"));
  styleSelect.appendChild(option("minimal", "Clean signal"));
  styleSelect.appendChild(option("wild", "Wild wall"));
  styleControl.appendChild(styleSelect);
  controlGrid.appendChild(styleControl);

  const placementControl = el("label", { className: "ai-control" });
  placementControl.appendChild(el("span", {}, "PLACEMENT"));
  const placementSelect = el("select", { "aria-label": "Artwork placement" }) as HTMLSelectElement;
  placementSelect.appendChild(option("auto", "Find open space"));
  placementSelect.appendChild(option("left", "Left"));
  placementSelect.appendChild(option("center", "Center"));
  placementSelect.appendChild(option("right", "Right"));
  placementControl.appendChild(placementSelect);
  controlGrid.appendChild(placementControl);
  hero.appendChild(controlGrid);

  const commandActions = el("div", { className: "ai-command-actions" });
  const generateButton = el("button", { type: "button", className: "ai-generate-button" }, "GENERATE PLAN ↗") as HTMLButtonElement;
  const variationButton = el("button", { type: "button", className: "ai-variation-button" }, "↻ Another take") as HTMLButtonElement;
  const syncButton = el("button", { type: "button", className: "ai-sync-button" }, "↻ Sync walls") as HTMLButtonElement;
  commandActions.appendChild(generateButton);
  commandActions.appendChild(variationButton);
  commandActions.appendChild(syncButton);
  hero.appendChild(commandActions);

  const safetyStrip = el("div", { className: "ai-safety-strip" });
  safetyStrip.appendChild(el("strong", {}, "DRAFT FIRST"));
  safetyStrip.appendChild(el("span", {}, "Generate → inspect → stage → Post"));
  safetyStrip.appendChild(el("span", {}, `MAX ${MAX_EVENTS_PER_POST} EVENTS`));
  hero.appendChild(safetyStrip);
  main.appendChild(hero);

  const previewSection = el("section", { className: "ai-preview-panel" });
  const previewHeader = el("div", { className: "ai-preview-header" });
  const previewHeading = el("div", {});
  previewHeading.appendChild(el("span", { className: "ai-section-number" }, "02 / REVIEW THE MARKS"));
  const previewTitle = el("h2", {}, "Waiting for a direction");
  previewHeading.appendChild(previewTitle);
  previewHeader.appendChild(previewHeading);
  const previewStatus = el("span", { className: "ai-preview-status" }, "READY");
  previewHeader.appendChild(previewStatus);
  previewSection.appendChild(previewHeader);

  const canvasFrame = el("div", { className: "ai-canvas-frame" });
  const baseCanvas = document.createElement("canvas");
  const previewCanvas = document.createElement("canvas");
  baseCanvas.className = "ai-base-canvas";
  previewCanvas.className = "ai-preview-canvas";
  baseCanvas.setAttribute("aria-hidden", "true");
  previewCanvas.setAttribute("role", "img");
  previewCanvas.setAttribute("aria-label", "AI artwork preview on the selected COMP Wall");
  configureWallCanvas(baseCanvas);
  configureWallCanvas(previewCanvas);
  canvasFrame.appendChild(previewCanvas);
  const canvasCorner = el("span", { className: "ai-canvas-corner" }, "1920 × 1080 / WALL EVENT SPACE");
  canvasFrame.appendChild(canvasCorner);
  const emptyCanvas = el("div", { className: "ai-canvas-empty" });
  emptyCanvas.appendChild(el("span", {}, "✦"));
  emptyCanvas.appendChild(el("strong", {}, "YOUR PROMPT BECOMES MARKS HERE"));
  canvasFrame.appendChild(emptyCanvas);
  previewSection.appendChild(canvasFrame);

  const previewActions = el("div", { className: "ai-preview-actions" });
  const undoButton = el("button", { type: "button", "aria-label": "Undo last generated event" }, "↶ Undo mark") as HTMLButtonElement;
  const clearButton = el("button", { type: "button" }, "× Clear") as HTMLButtonElement;
  const copyButton = el("button", { type: "button" }, "{} Copy events") as HTMLButtonElement;
  const stageButton = el("button", { type: "button", className: "ai-stage-button", "data-testid": "ai-stage-button" }, "STAGE ON WALL →") as HTMLButtonElement;
  previewActions.appendChild(undoButton);
  previewActions.appendChild(clearButton);
  previewActions.appendChild(copyButton);
  previewActions.appendChild(stageButton);
  previewSection.appendChild(previewActions);
  main.appendChild(previewSection);

  const traceSection = el("aside", { className: "ai-trace-panel" });
  const traceHead = el("div", { className: "ai-trace-head" });
  traceHead.appendChild(el("span", { className: "ai-section-number" }, "03 / AGENT TRACE"));
  const eventCount = el("strong", {}, "0 EVENTS");
  traceHead.appendChild(eventCount);
  traceSection.appendChild(traceHead);
  const traceIntro = el("p", {}, "Every generated action is a valid, inspectable COMP Wall v1 event.");
  traceSection.appendChild(traceIntro);
  const eventList = el("ol", { className: "ai-event-list", "aria-live": "polite" });
  traceSection.appendChild(eventList);

  const capabilityGrid = el("div", { className: "ai-capability-grid" });
  [
    ["✎", "DRAW"],
    ["T", "WRITE"],
    ["○", "SHAPE"],
    ["◇", "ERASE"],
    ["⌖", "PLACE"],
    ["↗", "STAGE"],
  ].forEach(([icon, label]) => {
    const cell = el("span", {});
    cell.appendChild(el("b", {}, icon));
    cell.appendChild(document.createTextNode(label));
    capabilityGrid.appendChild(cell);
  });
  traceSection.appendChild(capabilityGrid);

  const exactPanel = el("details", { className: "ai-exact-panel" });
  exactPanel.appendChild(el("summary", {}, "ADVANCED · EXACT EVENT JSON"));
  exactPanel.appendChild(el("p", {}, "Agents can supply one event, an event array, or a batch object with an events field."));
  const exactInput = el("textarea", {
    rows: "7",
    spellcheck: "false",
    "aria-label": "Graffiti event JSON",
    placeholder: '[{"type":"text","x":120,"y":160,"text":"GM CKB","color":"#151515","size":64}]',
  }) as HTMLTextAreaElement;
  exactPanel.appendChild(exactInput);
  const exactActions = el("div", { className: "ai-exact-actions" });
  const exactPreviewButton = el("button", { type: "button" }, "Validate & preview") as HTMLButtonElement;
  const exactExportButton = el("button", { type: "button" }, "Load current plan") as HTMLButtonElement;
  exactActions.appendChild(exactPreviewButton);
  exactActions.appendChild(exactExportButton);
  exactPanel.appendChild(exactActions);
  traceSection.appendChild(exactPanel);

  const companion = el("div", { className: "ai-skill-companion" });
  const companionCopy = el("span", {});
  companionCopy.appendChild(el("strong", {}, "CLI COMPANION"));
  companionCopy.appendChild(el("small", {}, "Give a local AI channel query and message tools."));
  companion.appendChild(companionCopy);
  companion.appendChild(
    el(
      "a",
      {
        href: new URL("downloads/comp-shared-lock-skill.zip", document.baseURI).toString(),
        download: "comp-shared-lock-skill.zip",
      },
      "↓ SKILL",
    ),
  );
  traceSection.appendChild(companion);
  main.appendChild(traceSection);
  app.appendChild(main);

  const footer = el("footer", { className: "ai-studio-footer" });
  footer.appendChild(el("strong", {}, "COMP WALL / AI-NATIVE CREATION SURFACE"));
  footer.appendChild(el("span", {}, "No model key · no wallet needed to compose · every mark reviewable"));
  app.appendChild(footer);

  function renderWallOptions(): void {
    const previous = selectedHash;
    wallSelect.innerHTML = "";
    if (channels.length === 0 && !selectedHash) {
      wallSelect.appendChild(option("", "No discovered walls"));
      selectedHash = "";
      return;
    }
    for (const channel of channels) {
      wallSelect.appendChild(option(channel.hash, `#${channel.name.replace(/^#/, "")} · ${channel.cells.length} lanes`));
    }
    if (selectedHash && !channels.some((channel) => channel.hash.toLowerCase() === selectedHash.toLowerCase())) {
      wallSelect.appendChild(option(selectedHash, `Selected Wall · ${selectedHash.slice(0, 10)}…`));
    }
    selectedHash = channels.find((channel) => channel.hash.toLowerCase() === previous.toLowerCase())?.hash ||
      previous || channels[0]?.hash || "";
    wallSelect.value = selectedHash;
  }

  function renderPreview(): void {
    renderEventSequence(baseCanvas, baseEvents);
    renderEventSequence(previewCanvas, plan?.events ?? [], baseCanvas);
    emptyCanvas.hidden = baseEvents.length > 0 || Boolean(plan?.events.length);
    previewTitle.textContent = plan?.title ?? "Waiting for a direction";
    previewStatus.textContent = plan
      ? `${plan.events.length} MARKS · ${plan.vertical.toUpperCase()} ${plan.placement.toUpperCase()}`
      : `${baseEvents.length} ON WALL`;
    previewStatus.classList.toggle("has-plan", Boolean(plan));
  }

  function renderTrace(): void {
    eventList.innerHTML = "";
    const events = plan?.events ?? [];
    eventCount.textContent = `${events.length} ${events.length === 1 ? "EVENT" : "EVENTS"}`;
    if (events.length === 0) {
      const empty = el("li", { className: "ai-event-empty" }, "No plan yet. Choose a preset or write a brief.");
      eventList.appendChild(empty);
    } else {
      events.forEach((event, index) => {
        const item = el("li", {});
        item.appendChild(el("span", { className: "ai-event-index" }, String(index + 1).padStart(2, "0")));
        const copy = el("span", { className: "ai-event-copy" });
        copy.appendChild(el("strong", {}, event.type.toUpperCase()));
        copy.appendChild(el("small", {}, describeAiEvent(event)));
        item.appendChild(copy);
        const color = event.type === "erase" ? "#f4f0e7" : event.color;
        const dot = el("span", { className: "ai-event-color", title: color });
        dot.style.background = color;
        item.appendChild(dot);
        eventList.appendChild(item);
      });
    }
    undoButton.disabled = events.length === 0;
    clearButton.disabled = events.length === 0;
    copyButton.disabled = events.length === 0;
    stageButton.disabled = events.length === 0 || !selectedHash;
    stageButton.textContent = events.length ? `STAGE ${events.length} ON WALL →` : "STAGE ON WALL →";
    variationButton.disabled = !promptInput.value.trim();
  }

  function renderAll(): void {
    renderPreview();
    renderTrace();
  }

  async function loadWallPreview(hash: string): Promise<void> {
    selectedHash = hash;
    const [stored, draft] = await Promise.all([readWallRecords(hash), readWallDraft(hash)]);
    if (cancelled || hash !== selectedHash) return;
    const fromMessages = recordsFromMessages(readCachedMessages(hash, 200)?.value ?? []);
    baseEvents = mergeGraffitiRecords(stored?.records ?? [], fromMessages)
      .filter((record) => record.status === "confirmed")
      .map((record) => record.event);
    savedDraft = draft;
    plan = undefined;
    variation = 0;
    renderAll();
  }

  function createPlan(nextVariation: number): void {
    variation = nextVariation;
    plan = generateAiArtwork({
      prompt: promptInput.value,
      style: styleSelect.value as AiArtStyle,
      placement: placementSelect.value as AiPlacement,
      variation,
      existingEvents: [...baseEvents, ...savedDraft],
    });
    renderAll();
    toast(`${plan.title} · ${plan.events.length} marks ready to review`, "ok");
  }

  async function copyEvents(): Promise<void> {
    if (!plan) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(plan.events, null, 2));
      toast("Wall event plan copied", "ok");
    } catch {
      toast("Copy failed. Open exact JSON and select the plan manually.", "err");
    }
  }

  function oneClickDrawPrompt(): string {
    const wallUrl = selectedHash
      ? `${location.origin}${location.pathname}#/wall/${encodeURIComponent(selectedHash)}`
      : `${location.origin}${location.pathname}#/`;
    const brief = promptInput.value.trim() || STARTER_PROMPT;
    return `Use $comp-wall-artist to draw “${brief}” on ${wallUrl} and post it anonymously.`;
  }

  async function stagePlan(): Promise<void> {
    if (!plan || !selectedHash) return;
    const currentDraft = await readWallDraft(selectedHash);
    const combined = [...currentDraft, ...plan.events];
    if (combined.length > MAX_EVENTS_PER_POST) {
      toast(`Wall draft would contain ${combined.length} events; keep it at ${MAX_EVENTS_PER_POST} or fewer.`, "err");
      return;
    }
    await saveWallDraft(selectedHash, combined);
    toast(`${plan.events.length} AI marks staged. Review and Post on the Wall.`, "ok");
    navigate(`/wall/${encodeURIComponent(selectedHash)}`);
  }

  async function syncWalls(): Promise<void> {
    syncButton.disabled = true;
    syncButton.textContent = "SYNCING…";
    try {
      channels = uniqueChannels(await discoverChannels());
      const previous = selectedHash;
      renderWallOptions();
      await loadWallPreview(channels.some((channel) => channel.hash === previous) ? previous : selectedHash);
      toast(`${channels.length} live ${channels.length === 1 ? "wall" : "walls"} found`, "ok");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "err");
    } finally {
      syncButton.disabled = false;
      syncButton.textContent = "↻ Sync walls";
    }
  }

  PROMPT_PRESETS.forEach(([icon, label, prompt]) => {
    const button = el("button", { type: "button", className: "ai-preset-button" }) as HTMLButtonElement;
    button.appendChild(el("span", {}, icon));
    button.appendChild(el("strong", {}, label));
    button.addEventListener("click", () => {
      promptInput.value = prompt;
      createPlan(0);
    });
    presetRail.appendChild(button);
  });

  generateButton.addEventListener("click", () => createPlan(0));
  variationButton.addEventListener("click", () => createPlan(variation + 1));
  syncButton.addEventListener("click", () => void syncWalls());
  wallSelect.addEventListener("change", () => void loadWallPreview(wallSelect.value));
  styleSelect.addEventListener("change", () => { if (plan) createPlan(variation); });
  placementSelect.addEventListener("change", () => { if (plan) createPlan(variation); });
  promptInput.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      createPlan(0);
    }
  });
  undoButton.addEventListener("click", () => {
    plan?.events.pop();
    renderAll();
  });
  clearButton.addEventListener("click", () => {
    plan = undefined;
    variation = 0;
    renderAll();
  });
  copyButton.addEventListener("click", () => void copyEvents());
  stageButton.addEventListener("click", () => void stagePlan());
  exactPreviewButton.addEventListener("click", () => {
    try {
      const events = parseExactEvents(exactInput.value);
      plan = {
        title: "Exact Event Plan",
        note: "Validated against COMP Wall v1",
        subject: "abstract",
        seed: 0,
        palette: [],
        placement: "center",
        vertical: "middle",
        events,
      };
      renderAll();
      toast(`${events.length} exact ${events.length === 1 ? "event" : "events"} validated`, "ok");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "err");
    }
  });
  exactExportButton.addEventListener("click", () => {
    exactInput.value = JSON.stringify(plan?.events ?? [], null, 2);
  });
  copyInstallButton.addEventListener("click", () => void copyToClipboard(ARTIST_SKILL_INSTALL_COMMAND, "Codex + Claude install command"));
  copyDrawButton.addEventListener("click", () => void copyToClipboard(oneClickDrawPrompt(), "One-click draw prompt"));

  renderWallOptions();
  if (selectedHash) void loadWallPreview(selectedHash);
  else renderAll();

  return () => {
    cancelled = true;
  };
}
