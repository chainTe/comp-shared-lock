import { parseGraffitiPayload, recordsFromMessages } from "../compWall";
import { channelRoute } from "../channelNames";
import { discoverChannels } from "../resolver";
import { readCachedChannels, readCachedMessages } from "../scanCache";
import type { Channel, ChannelKind, Message } from "../types";
import { formatCapacity, truncateHash } from "../utils";
import { configureWallCanvas, renderRecordSequence } from "../wallCanvas";
import { el, toast } from "./common";

function brandBar(): HTMLElement {
  const header = el("header", { className: "wall-global-bar" });
  const brand = el("a", { href: "#/", className: "wall-brand" });
  brand.appendChild(el("span", { className: "wall-brand-mark", "aria-hidden": "true" }, "C"));
  brand.appendChild(el("span", {}, "COMP SPACES"));
  header.appendChild(brand);
  header.appendChild(el("span", { className: "network-pill" }, "● CKB TESTNET"));
  const spacer = el("span", { className: "wall-spacer" });
  header.appendChild(spacer);
  header.appendChild(el("a", { href: "#/channels/new", className: "outline-button compact header-create-chat" }, "+ Text Room"));
  header.appendChild(el("a", { href: "#/walls/new", className: "ink-button compact" }, "+ Canvas Wall"));
  return header;
}

function presentedKind(channel: Channel, messages: Message[]): ChannelKind {
  if (channel.kind) return channel.kind;
  if (messages.some((message) => parseGraffitiPayload(message.payload))) return "wall";
  return messages.length > 0 ? "chat" : "wall";
}

function chatPreview(messages: Message[]): HTMLElement {
  const preview = el("div", { className: "wall-card-preview chat-card-preview" });
  const textMessages = messages
    .filter((message) => !parseGraffitiPayload(message.payload))
    .slice(0, 3)
    .reverse();
  const stream = el("div", { className: "chat-preview-stream", "aria-hidden": "true" });
  const logHeader = el("div", { className: "chat-preview-log-header" });
  logHeader.appendChild(el("strong", {}, "OPEN ANONYMOUS LOG"));
  logHeader.appendChild(el("span", {}, "NO PROFILES"));
  stream.appendChild(logHeader);
  if (textMessages.length > 0) {
    for (const message of textMessages) {
      const row = el("div", { className: "chat-preview-message" });
      row.appendChild(el("span", { className: "chat-preview-signal" }, "●"));
      row.appendChild(el("span", { className: "chat-preview-copy" }, message.payload.slice(0, 110)));
      stream.appendChild(row);
    }
  } else {
    const empty = el("div", { className: "chat-preview-empty" });
    empty.appendChild(el("span", { "aria-hidden": "true" }, "···"));
    empty.appendChild(el("strong", {}, "Waiting for an anonymous message"));
    empty.appendChild(el("small", {}, "No profile · no avatar · just text"));
    stream.appendChild(empty);
  }
  preview.appendChild(stream);
  preview.appendChild(el("span", { className: "wall-card-live chat-kind-badge" }, "TEXT ROOM"));
  return preview;
}

function spaceCard(channel: Channel): HTMLElement {
  const messages = readCachedMessages(channel.hash, 200)?.value ?? [];
  const kind = presentedKind(channel, messages);
  const records = recordsFromMessages(messages);
  const card = el("a", {
    href: channelRoute(channel.hash, kind),
    className: `wall-card ${kind === "chat" ? "is-chat" : "is-wall"}`,
    "aria-label": `Open ${channel.name}`,
  });
  if (kind === "chat") {
    card.appendChild(chatPreview(messages));
  } else {
    const preview = el("div", { className: "wall-card-preview" });
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    configureWallCanvas(canvas);
    renderRecordSequence(canvas, records.filter((record) => record.status === "confirmed"));
    preview.appendChild(canvas);
    preview.appendChild(el("span", { className: "wall-card-live" }, "CANVAS WALL"));
    card.appendChild(preview);
  }

  const body = el("div", { className: "wall-card-body" });
  const heading = el("div", { className: "wall-card-heading" });
  heading.appendChild(el("h3", {}, `#${channel.name.replace(/^#/, "")}`));
  heading.appendChild(el("span", { className: "wall-card-arrow" }, "↗"));
  body.appendChild(heading);
  body.appendChild(
    el(
      "p",
      { className: "wall-card-stats" },
      kind === "chat"
        ? `${messages.length.toLocaleString()} messages · ${channel.cells.length} message ${channel.cells.length === 1 ? "lane" : "lanes"}`
        : `${records.length.toLocaleString()} marks · ${channel.cells.length} paint ${channel.cells.length === 1 ? "lane" : "lanes"}`,
    ),
  );
  const supply = el("div", { className: "wall-card-supply" });
  supply.appendChild(el("span", {}, kind === "chat" ? "MESSAGE SUPPLY" : "PAINT SUPPLY"));
  supply.appendChild(el("strong", {}, formatCapacity(channel.totalCapacity)));
  body.appendChild(supply);
  body.appendChild(el("code", { className: "wall-card-hash" }, truncateHash(channel.hash, 8, 6)));
  card.appendChild(body);
  return card;
}

export function wallExplorerView(): () => void {
  const app = document.getElementById("app")!;
  app.innerHTML = "";
  app.className = "comp-wall-app";
  app.appendChild(brandBar());

  const main = el("main", { className: "explorer-main" });
  const hero = el("section", { className: "wall-hero" });
  const copy = el("div", { className: "wall-hero-copy" });
  copy.appendChild(el("span", { className: "eyebrow" }, "PERMISSIONLESS PUBLIC SPACES"));
  copy.appendChild(el("h1", {}, "Draw together. Talk forever."));
  copy.appendChild(
    el(
      "p",
      {},
      "Draw on a shared canvas or join a text room—without an account or gas. Every mark and message becomes part of a verifiable community history on CKB.",
    ),
  );
  const heroActions = el("div", { className: "hero-actions" });
  const exploreButton = el("button", { className: "ink-button", type: "button" }, "Explore live spaces ↓") as HTMLButtonElement;
  heroActions.appendChild(exploreButton);
  heroActions.appendChild(el("a", { href: "#/channels/new", className: "outline-button" }, "Start a text room"));
  copy.appendChild(heroActions);
  hero.appendChild(copy);

  const manifesto = el("div", { className: "wall-manifesto", "aria-hidden": "true" });
  manifesto.appendChild(el("span", { className: "spray-word one" }, "DRAW"));
  manifesto.appendChild(el("span", { className: "spray-word two" }, "TOGETHER"));
  manifesto.appendChild(el("span", { className: "spray-heart" }, "♥"));
  manifesto.appendChild(el("span", { className: "chain-stamp" }, "ON-CHAIN / FOREVER"));
  hero.appendChild(manifesto);
  main.appendChild(hero);

  const heading = el("section", { className: "explorer-section-heading" });
  const title = el("div", {});
  title.appendChild(el("span", { className: "eyebrow" }, "SPACE EXPLORER"));
  title.appendChild(el("h2", {}, "Pick a space. Add to the story."));
  heading.appendChild(title);
  const scanStatus = el("span", { className: "scan-chip" }, "CHECKING THE CHAIN…");
  heading.appendChild(scanStatus);
  main.appendChild(heading);

  const grid = el("section", { className: "wall-grid", id: "wall-grid", "aria-live": "polite" });
  main.appendChild(grid);
  app.appendChild(main);

  let cancelled = false;
  const cached = readCachedChannels();

  function render(channels: Channel[], live: boolean): void {
    grid.innerHTML = "";
    scanStatus.textContent = live ? `● ${channels.length} LIVE SPACES` : `${channels.length} SAVED SPACES`;
    scanStatus.className = `scan-chip ${live ? "is-live" : ""}`;
    if (channels.length === 0) {
      const empty = el("div", { className: "wall-empty-card" });
      empty.appendChild(el("span", { className: "empty-mark" }, "+"));
      empty.appendChild(el("h3", {}, "The first space is yours."));
      empty.appendChild(el("p", {}, "Create a shared Cell, add supply, and invite everyone in."));
      const emptyActions = el("div", { className: "hero-actions empty-actions" });
      emptyActions.appendChild(el("a", { href: "#/channels/new", className: "outline-button" }, "Start a Text Room"));
      emptyActions.appendChild(el("a", { href: "#/walls/new", className: "ink-button" }, "Create a Wall"));
      empty.appendChild(emptyActions);
      grid.appendChild(empty);
      return;
    }
    channels.forEach((channel) => grid.appendChild(spaceCard(channel)));
  }

  if (cached) render(cached.value, false);
  else {
    grid.appendChild(el("div", { className: "wall-loading" }, "Scanning CKB for public spaces…"));
  }

  exploreButton.addEventListener("click", () => {
    document.getElementById("wall-grid")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  discoverChannels()
    .then((channels) => {
      if (!cancelled) render(channels, true);
    })
    .catch((error) => {
      if (cancelled) return;
      scanStatus.textContent = cached ? "OFFLINE · SHOWING SAVED" : "CHAIN UNAVAILABLE";
      scanStatus.className = "scan-chip is-offline";
      if (!cached) render([], false);
      toast(`Chain refresh paused: ${error instanceof Error ? error.message : String(error)}`, "err");
    });

  return () => {
    cancelled = true;
    app.className = "";
  };
}
