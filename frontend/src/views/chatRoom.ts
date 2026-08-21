import { loadPendingMessages, resolveChannelState } from "../resolver";
import { readCachedChannels, readCachedMessages } from "../scanCache";
import {
  anonymousIdentity,
  connectWallet,
  disconnectWallet,
  inBrowserIdentity,
  isWalletConnected,
  readyInBrowserIdentity,
} from "../identity";
import { postAnonymous, postSigned } from "../txBuilder";
import { formatCapacity, formatCapacityDelta, truncateHash } from "../utils";
import { EXPLORER_TX_URL, PENDING_POLL_INTERVAL_MS } from "../rpc";
import { copyMessageLink } from "../messageShare";
import type { ChannelState, Message, SigningIdentity } from "../types";
import { el, formatTime, navBar, spinner, toast } from "./common";

export function chatRoomView(channelHash: string): () => void {
  const app = document.getElementById("app")!;
  app.innerHTML = "";
  app.appendChild(navBar());

  let cancelled = false;
  let currentIdentity: SigningIdentity = anonymousIdentity();
  let walletIdentity: SigningIdentity | undefined;
  let state: ChannelState | undefined;
  let pollTimer: number | undefined;
  let confirmedLimit = 20;
  const LIMIT_STEP = 20;
  let refreshing = false;
  const cached = readCachedMessages(channelHash, confirmedLimit);
  let cachedChannel = readCachedChannels()?.value.find(
    (channel) => channel.hash.toLowerCase() === channelHash.toLowerCase(),
  );
  let cachedConfirmed = cached?.value ?? [];
  let lastUpdatedAt = cached?.updatedAt;
  let refreshError: string | undefined;

  const header = el("div", { className: "card" });
  app.appendChild(header);

  const composerCard = el("div", { className: "card" });
  app.appendChild(composerCard);

  const streamContainer = el("div", { className: "card" });
  streamContainer.appendChild(spinner("loading channel state…"));
  app.appendChild(streamContainer);

  // Composer DOM refs
  let selectEl: HTMLSelectElement | undefined;
  let textareaEl: HTMLTextAreaElement | undefined;
  let disconnectBtnEl: HTMLButtonElement | undefined;

  function renderHeader() {
    const channel = state?.channel ?? cachedChannel;
    if (!channel) return;
    header.innerHTML = "";
    header.appendChild(el("h2", {}, channel.name));
    const meta = el("div", { className: "row" });
    meta.appendChild(el("span", { className: "col muted" }, `hash: ${truncateHash(channel.hash)}`));
    meta.appendChild(
      el("span", { className: "col" }, `capacity: ${formatCapacity(channel.totalCapacity)}`),
    );
    meta.appendChild(el("span", { className: "col" }, `cells: ${channel.cells.length}`));
    header.appendChild(meta);

    const actions = el("div", { className: "row" });
    actions.appendChild(
      el("a", { href: `#/channel/${encodeURIComponent(channelHash)}/add-cell` }, "+ Add Cell"),
    );
    header.appendChild(actions);
  }

  function renderMessage(msg: Message) {
    const item = el("div", {
      className: "message-item",
    });

    const top = el("div", { className: "row" });
    const statusClass = msg.status === "pending" ? "pending" : "ok";
    const statusIcon = msg.status === "pending" ? "⏳ Pending" : "✓ Confirmed";

    const author = msg.author === "Anonymous" || msg.author.length <= 24
      ? msg.author
      : `${msg.author.slice(0, 12)}…${msg.author.slice(-8)}`;
    top.appendChild(el("strong", { className: "col", title: msg.author }, author));
    top.appendChild(el("span", { className: `col ${statusClass}` }, statusIcon));
    item.appendChild(top);

    const payload = el("div", { className: "message-payload" }, msg.payload);
    payload.style.whiteSpace = "pre-wrap";
    payload.style.overflowWrap = "anywhere";
    payload.style.marginTop = "0.5rem";
    item.appendChild(payload);

    const isLong = msg.payload.length > 600 || msg.payload.split("\n").length > 12;
    if (isLong) {
      payload.classList.add("is-collapsed");
      const expandBtn = el(
        "button",
        { className: "secondary message-expand", "aria-expanded": "false" },
        "Show full message",
      ) as HTMLButtonElement;
      expandBtn.addEventListener("click", () => {
        const collapsed = payload.classList.toggle("is-collapsed");
        expandBtn.textContent = collapsed ? "Show full message" : "Collapse message";
        expandBtn.setAttribute("aria-expanded", String(!collapsed));
      });
      item.appendChild(expandBtn);
    }

    const bottom = el("div", { className: "row muted message-meta" });
    bottom.appendChild(el("span", { className: "col" }, formatTime(msg.timestamp)));
    if (msg.blockNumber !== undefined) {
      bottom.appendChild(el("span", { className: "col" }, `block #${msg.blockNumber}`));
    }
    if (msg.capacityDelta !== undefined) {
      bottom.appendChild(el("span", { className: "col" }, formatCapacityDelta(msg.capacityDelta)));
    }
    const txLink = el("a", { href: `${EXPLORER_TX_URL}${msg.txHash}`, target: "_blank" }, msg.txHash.slice(0, 12) + "…");
    const txCol = el("span", { className: "col" }, "tx: ");
    txCol.appendChild(txLink);
    bottom.appendChild(txCol);
    const shareBtn = el(
      "button",
      {
        className: "secondary message-share",
        type: "button",
        title: "Copy a direct link to this message",
        "aria-label": `Copy link to message ${msg.txHash}`,
      },
      "⧉ Copy link",
    ) as HTMLButtonElement;
    shareBtn.addEventListener("click", async () => {
      shareBtn.disabled = true;
      try {
        await copyMessageLink(channelHash, msg.txHash);
        toast("Message link copied.", "ok");
      } catch (error) {
        toast(
          `Could not copy message link: ${error instanceof Error ? error.message : String(error)}`,
          "err",
        );
      } finally {
        shareBtn.disabled = false;
      }
    });
    bottom.appendChild(shareBtn);
    item.appendChild(bottom);

    return item;
  }

  function renderStream() {
    streamContainer.innerHTML = "";
    const heading = el("div", { className: "row message-heading" });
    heading.appendChild(el("h3", { className: "col" }, "Messages"));
    const refreshBtn = el(
      "button",
      { className: "secondary" },
      refreshing ? "Refreshing…" : "Refresh",
    ) as HTMLButtonElement;
    refreshBtn.disabled = refreshing;
    refreshBtn.addEventListener("click", () => void refresh());
    heading.appendChild(refreshBtn);
    streamContainer.appendChild(heading);

    // Pending messages first (newest unconfirmed at the very top).
    const confirmed = state?.confirmed ?? cachedConfirmed;
    const pending = state?.pending ?? [];
    const all = [...pending, ...confirmed];
    const cacheStatus = lastUpdatedAt
      ? `Saved locally · updated ${new Date(lastUpdatedAt).toLocaleString()}`
      : "No saved scan yet";
    const refreshStatus = refreshing
      ? " · checking the chain once…"
      : pending.length > 0
        ? " · watching pending transaction only"
        : " · refresh on demand";
    streamContainer.appendChild(
      el(
        "p",
        { className: "muted scan-status" },
        `${all.length} messages · ${cacheStatus}${refreshStatus}`,
      ),
    );
    if (refreshError) {
      streamContainer.appendChild(el("div", { className: "err scan-error" }, refreshError));
    }
    if (all.length === 0) {
      streamContainer.appendChild(
        refreshing
          ? spinner("checking for messages…")
          : el("p", { className: "muted" }, "No messages yet. Be the first to post!"),
      );
      return;
    }

    for (const msg of all) {
      streamContainer.appendChild(renderMessage(msg));
    }

    if (state?.hasMoreConfirmed) {
      const loadMoreBtn = el("button", { className: "col" }, "Load older messages") as HTMLButtonElement;
      loadMoreBtn.style.marginTop = "1rem";
      loadMoreBtn.addEventListener("click", () => {
        confirmedLimit += LIMIT_STEP;
        void refresh();
      });
      streamContainer.appendChild(loadMoreBtn);
    }
  }

  function buildIdentityOptions() {
    if (!selectEl) return;
    const value = selectEl.value;
    selectEl.innerHTML = "";

    selectEl.appendChild(el("option", { value: "anonymous" }, "Anonymous") as HTMLOptionElement);
    selectEl.appendChild(
      el("option", { value: "key" }, inBrowserIdentity().label) as HTMLOptionElement,
    );
    selectEl.appendChild(
      el("option", { value: "connect" }, "Connect Wallet") as HTMLOptionElement,
    );

    if (isWalletConnected() && walletIdentity) {
      selectEl.appendChild(
        el("option", { value: "wallet" }, walletIdentity.label) as HTMLOptionElement,
      );
    }

    // Restore selection.
    if (value && Array.from(selectEl.options).some((o) => o.value === value)) {
      selectEl.value = value;
    } else if (currentIdentity.mode === "anonymous") {
      selectEl.value = "anonymous";
    } else if (currentIdentity.mode === "key") {
      selectEl.value = "key";
    } else if (currentIdentity.mode === "wallet") {
      selectEl.value = "wallet";
    }
  }

  function updateDisconnectButton() {
    if (!disconnectBtnEl) return;
    disconnectBtnEl.style.display = isWalletConnected() ? "" : "none";
  }

  function renderComposer() {
    composerCard.innerHTML = "";
    composerCard.appendChild(el("h3", {}, "Post a message"));

    const identityRow = el("div", { className: "row" });
    identityRow.appendChild(el("label", { className: "col" }, "Post as:"));
    selectEl = el("select", { className: "col" }) as HTMLSelectElement;
    buildIdentityOptions();

    selectEl.addEventListener("change", async () => {
      const value = selectEl!.value;
      if (value === "anonymous") {
        currentIdentity = anonymousIdentity();
      } else if (value === "key") {
        currentIdentity = await readyInBrowserIdentity();
        buildIdentityOptions();
      } else if (value === "connect") {
        const connected = await connectWallet();
        if (connected) {
          walletIdentity = connected;
          currentIdentity = connected;
          buildIdentityOptions();
          updateDisconnectButton();
        } else {
          selectEl!.value = "anonymous";
          currentIdentity = anonymousIdentity();
        }
      } else if (value === "wallet") {
        currentIdentity = walletIdentity ?? anonymousIdentity();
      }
    });

    identityRow.appendChild(selectEl);
    composerCard.appendChild(identityRow);

    textareaEl = el("textarea", {
      rows: "3",
      placeholder: "Write something…",
    }) as HTMLTextAreaElement;
    composerCard.appendChild(textareaEl);

    const btnRow = el("div", { className: "row" });
    const sendBtn = el("button", { className: "col" }, "Send") as HTMLButtonElement;
    disconnectBtnEl = el("button", { className: "col secondary" }, "Disconnect Wallet") as HTMLButtonElement;
    updateDisconnectButton();

    sendBtn.addEventListener("click", async () => {
      const payload = textareaEl!.value.trim();
      if (!payload) {
        toast("enter a message", "err");
        return;
      }
      sendBtn.disabled = true;
      try {
        let txHash: string;
        if (currentIdentity.mode === "anonymous") {
          txHash = await postAnonymous(channelHash, payload);
        } else {
          txHash = await postSigned(channelHash, payload, currentIdentity);
        }
        toast(`message sent: ${txHash.slice(0, 16)}…`, "ok");
        textareaEl!.value = "";
        // Read only the submitted transaction here. A full chain scan runs
        // once after it settles, so sending does not duplicate the preflight scan.
        if (state) {
          void pollPending();
        } else {
          void refresh();
        }
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), "err");
      } finally {
        sendBtn.disabled = false;
      }
    });

    disconnectBtnEl.addEventListener("click", () => {
      disconnectWallet();
      walletIdentity = undefined;
      currentIdentity = anonymousIdentity();
      buildIdentityOptions();
      updateDisconnectButton();
    });

    btnRow.appendChild(sendBtn);
    btnRow.appendChild(disconnectBtnEl);
    composerCard.appendChild(btnRow);
  }

  function schedulePendingPoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = undefined;
    if (!state?.pending.length || cancelled) return;
    pollTimer = window.setTimeout(() => void pollPending(), PENDING_POLL_INTERVAL_MS);
  }

  async function pollPending() {
    if (cancelled || !state) return;
    try {
      const hadPending = state.pending.length > 0;
      state = { ...state, pending: await loadPendingMessages(channelHash) };
      renderStream();
      if (hadPending && state.pending.length === 0) {
        // Capture final block metadata once, then stop. Idle rooms never poll.
        await refresh();
        return;
      }
    } catch (e) {
      console.error("pollPending", e);
    }
    schedulePendingPoll();
  }

  async function refresh() {
    if (cancelled || refreshing) return;
    refreshing = true;
    refreshError = undefined;
    renderStream();
    try {
      state = await resolveChannelState(channelHash, confirmedLimit);
      cachedChannel = state.channel;
      cachedConfirmed = state.confirmed;
      lastUpdatedAt = Date.now();
      renderHeader();
    } catch (e) {
      refreshError = e instanceof Error ? e.message : String(e);
      if (cachedConfirmed.length) {
        toast(
          `refresh failed; showing saved messages: ${refreshError}`,
          "err",
        );
      }
    } finally {
      refreshing = false;
      renderStream();
      schedulePendingPoll();
    }
  }

  renderComposer();
  renderHeader();
  renderStream();
  void refresh();

  return () => {
    cancelled = true;
    if (pollTimer) clearTimeout(pollTimer);
  };
}
