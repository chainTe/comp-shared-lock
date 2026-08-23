import { recordsFromMessages } from "../compWall";
import { discoverChannels } from "../resolver";
import { readCachedChannels, readCachedMessages } from "../scanCache";
import type { Channel } from "../types";
import { formatCapacity, truncateHash } from "../utils";
import { configureWallCanvas, renderRecordSequence } from "../wallCanvas";
import { el, toast } from "./common";

function brandBar(): HTMLElement {
  const header = el("header", { className: "wall-global-bar" });
  const brand = el("a", { href: "#/", className: "wall-brand" });
  brand.appendChild(el("span", { className: "wall-brand-mark", "aria-hidden": "true" }, "C"));
  brand.appendChild(el("span", {}, "COMP WALL"));
  header.appendChild(brand);
  header.appendChild(el("span", { className: "network-pill" }, "● CKB TESTNET"));
  const spacer = el("span", { className: "wall-spacer" });
  header.appendChild(spacer);
  header.appendChild(el("a", { href: "#/ai", className: "quiet-link" }, "AI Studio"));
  header.appendChild(el("a", { href: "#/walls/new", className: "ink-button compact" }, "+ Create a Wall"));
  return header;
}

function wallCard(channel: Channel): HTMLElement {
  const messages = readCachedMessages(channel.hash, 200)?.value ?? [];
  const records = recordsFromMessages(messages);
  const card = el("a", {
    href: `#/wall/${encodeURIComponent(channel.hash)}`,
    className: "wall-card",
    "aria-label": `Open ${channel.name}`,
  });
  const preview = el("div", { className: "wall-card-preview" });
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  configureWallCanvas(canvas);
  renderRecordSequence(canvas, records.filter((record) => record.status === "confirmed"));
  preview.appendChild(canvas);
  preview.appendChild(el("span", { className: "wall-card-live" }, "● LIVE"));
  card.appendChild(preview);

  const body = el("div", { className: "wall-card-body" });
  const heading = el("div", { className: "wall-card-heading" });
  heading.appendChild(el("h3", {}, `#${channel.name.replace(/^#/, "")}`));
  heading.appendChild(el("span", { className: "wall-card-arrow" }, "↗"));
  body.appendChild(heading);
  body.appendChild(
    el(
      "p",
      { className: "wall-card-stats" },
      `${records.length.toLocaleString()} marks · ${channel.cells.length} paint ${channel.cells.length === 1 ? "lane" : "lanes"}`,
    ),
  );
  const supply = el("div", { className: "wall-card-supply" });
  supply.appendChild(el("span", {}, "PAINT SUPPLY"));
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
  copy.appendChild(el("span", { className: "eyebrow" }, "A PERMISSIONLESS PUBLIC CANVAS"));
  copy.appendChild(el("h1", {}, "Everyone can draw. History stays."));
  copy.appendChild(
    el(
      "p",
      {},
      "Leave a mark without an account or gas. Every stroke becomes part of a verifiable, replayable community history on CKB.",
    ),
  );
  const heroActions = el("div", { className: "hero-actions" });
  const exploreButton = el("button", { className: "ink-button", type: "button" }, "Explore live walls ↓") as HTMLButtonElement;
  heroActions.appendChild(exploreButton);
  heroActions.appendChild(el("a", { href: "#/walls/new", className: "outline-button" }, "Create your wall"));
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
  title.appendChild(el("span", { className: "eyebrow" }, "WALL EXPLORER"));
  title.appendChild(el("h2", {}, "Pick a wall. Add to the story."));
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
    scanStatus.textContent = live ? `● ${channels.length} LIVE WALLS` : `${channels.length} SAVED WALLS`;
    scanStatus.className = `scan-chip ${live ? "is-live" : ""}`;
    if (channels.length === 0) {
      const empty = el("div", { className: "wall-empty-card" });
      empty.appendChild(el("span", { className: "empty-mark" }, "+"));
      empty.appendChild(el("h3", {}, "The first wall is yours."));
      empty.appendChild(el("p", {}, "Create a shared Cell, add paint, and invite everyone in."));
      empty.appendChild(el("a", { href: "#/walls/new", className: "ink-button" }, "Create a Wall"));
      grid.appendChild(empty);
      return;
    }
    channels.forEach((channel) => grid.appendChild(wallCard(channel)));
  }

  if (cached) render(cached.value, false);
  else {
    grid.appendChild(el("div", { className: "wall-loading" }, "Scanning CKB for public walls…"));
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
