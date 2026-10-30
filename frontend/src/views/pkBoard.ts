import { resolveChannelState } from "../resolver";
import { readCachedMessages } from "../scanCache";
import { PENDING_POLL_INTERVAL_MS } from "../rpc";
import type { ChannelState, Message } from "../types";
import { el, formatTime, navBar, spinner, toast } from "./common";
import { truncateHash } from "../utils";

interface Side {
  hash: string;
  label: string;
  list: HTMLElement;
  state?: ChannelState;
  messages: Message[];
}

function messageItem(msg: Message): HTMLElement {
  const item = el("div", { className: "message-item" });
  item.appendChild(el("div", { className: "message-payload" }, msg.payload));
  const meta = el("div", { className: "row muted message-meta" });
  meta.appendChild(el("span", {}, msg.author ? truncateHash(msg.author, 4, 4) : "anonymous"));
  meta.appendChild(el("span", {}, formatTime(msg.timestamp)));
  item.appendChild(meta);
  return item;
}

const PAIRS_KEY = "comp-pk-pairs";

interface PairRecord {
  a: string;
  b: string;
}

function readPairs(): PairRecord[] {
  try {
    const raw = localStorage.getItem(PAIRS_KEY);
    const list = raw ? (JSON.parse(raw) as PairRecord[]) : [];
    return Array.isArray(list) ? list.filter((p) => typeof p?.a === "string" && typeof p?.b === "string") : [];
  } catch {
    return [];
  }
}

function rememberPair(a: string, b: string) {
  const list = readPairs().filter(
    (p) => !(p.a.toLowerCase() === a.toLowerCase() && p.b.toLowerCase() === b.toLowerCase()),
  );
  list.unshift({ a, b });
  localStorage.setItem(PAIRS_KEY, JSON.stringify(list.slice(0, 50)));
}

function messageCount(hash: string): number {
  return readCachedMessages(hash, 200)?.value?.length ?? 0;
}

/** 热搜：看过的 PK 板按两边留言总数排序（只读缓存，不打 RPC）。 */
function renderPopular(container: HTMLElement, current: PairRecord) {
  container.innerHTML = "";
  const pairs = readPairs();
  if (!pairs.length) return;
  const ranked = pairs
    .map((p) => ({ ...p, count: messageCount(p.a) + messageCount(p.b) }))
    .sort((x, y) => y.count - x.count)
    .slice(0, 5);
  container.appendChild(el("h3", {}, "热门 PK"));
  const list = el("div", { className: "pk-popular" });
  for (const pair of ranked) {
    const isCurrent =
      pair.a.toLowerCase() === current.a.toLowerCase() && pair.b.toLowerCase() === current.b.toLowerCase();
    const link = el("a", {
      className: isCurrent ? "pk-popular-item current" : "pk-popular-item",
      href: `#/pk/${pair.a}/${pair.b}`,
    });
    link.appendChild(el("span", {}, `${truncateHash(pair.a, 4, 4)} vs ${truncateHash(pair.b, 4, 4)}`));
    link.appendChild(el("span", { className: "muted" }, `${pair.count} 条`));
    list.appendChild(link);
  }
  container.appendChild(list);
}

export function pkBoardView(hashA: string, hashB: string): () => void {
  const app = document.getElementById("app")!;
  app.innerHTML = "";
  app.appendChild(navBar());

  let cancelled = false;
  let timer: number | undefined;

  const heading = el("div", { className: "card" });
  heading.appendChild(el("h2", {}, "PK 留言板"));
  heading.appendChild(
    el("p", { className: "muted" }, "左边一块，右边一块，各说各的。"),
  );
  app.appendChild(heading);

  rememberPair(hashA, hashB);
  const popular = el("div", { className: "card" });
  renderPopular(popular, { a: hashA, b: hashB });
  app.appendChild(popular);

  const grid = el("div", { className: "pk-grid" });
  app.appendChild(grid);

  const makeSide = (hash: string, fallback: string): Side => {
    const column = el("div", { className: "card pk-column" });
    const title = el("h3", { className: "pk-title" }, fallback);
    const list = el("div", { className: "pk-stream" });
    list.appendChild(spinner("loading…"));
    column.appendChild(title);
    column.appendChild(list);
    grid.appendChild(column);
    return { hash, label: fallback, list, messages: [] };
  };

  const sides = [makeSide(hashA, `A · ${truncateHash(hashA)}`), makeSide(hashB, `B · ${truncateHash(hashB)}`)];

  function renderSide(side: Side) {
    side.list.innerHTML = "";
    if (side.state) {
      side.label = `#${side.state.channel.name.replace(/^#/, "")}`;
    }
    const messages = side.messages.slice().sort((a, b) => {
      const at = a.timestamp ?? BigInt(Number.MAX_SAFE_INTEGER);
      const bt = b.timestamp ?? BigInt(Number.MAX_SAFE_INTEGER);
      return at < bt ? 1 : at > bt ? -1 : 0;
    });
    if (!messages.length) {
      side.list.appendChild(el("p", { className: "muted" }, "还没有留言"));
      return;
    }
    for (const msg of messages) side.list.appendChild(messageItem(msg));
  }

  async function loadSide(side: Side) {
    try {
      const state = await resolveChannelState(side.hash, 20);
      if (cancelled) return;
      side.state = state;
      side.messages = [...state.pending, ...state.confirmed];
      renderSide(side);
      // 标题跟着频道名走
      const title = side.list.parentElement?.querySelector(".pk-title");
      if (title) title.textContent = side.label;
    } catch (err) {
      if (cancelled) return;
      side.list.innerHTML = "";
      side.list.appendChild(el("p", { className: "muted" }, "加载失败"));
      toast(`加载 ${truncateHash(side.hash)} 失败`);
      console.error(err);
    }
  }

  function refresh() {
    for (const side of sides) void loadSide(side);
  }

  // 先拿缓存，别干等
  for (const side of sides) {
    const cached = readCachedMessages(side.hash, 20);
    if (cached?.value?.length) {
      side.messages = cached.value;
      renderSide(side);
    }
  }

  refresh();
  timer = window.setInterval(() => {
    if (!cancelled) refresh();
  }, PENDING_POLL_INTERVAL_MS);

  return () => {
    cancelled = true;
    if (timer !== undefined) window.clearInterval(timer);
  };
}
