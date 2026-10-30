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
