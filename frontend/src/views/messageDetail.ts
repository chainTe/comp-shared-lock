import { copyMessageLink } from "../messageShare";
import { resolveMessageTransaction } from "../resolver";
import { EXPLORER_TX_URL } from "../rpc";
import { formatCapacity, formatCapacityDelta } from "../utils";
import { el, formatTime, navBar, spinner, toast } from "./common";

export function messageDetailView(channelHash: string, txHash: string): () => void {
  const app = document.getElementById("app")!;
  app.innerHTML = "";
  app.appendChild(navBar());

  let cancelled = false;
  const container = el("main", { className: "card message-detail" });
  container.appendChild(spinner("loading transaction…"));
  app.appendChild(container);

  async function render() {
    try {
      const detail = await resolveMessageTransaction(channelHash, txHash);
      if (cancelled) return;
      const { message } = detail;
      container.innerHTML = "";

      const heading = el("div", { className: "row message-heading" });
      const title = el("div", { className: "col" });
      title.appendChild(el("h2", {}, "Message details"));
      title.appendChild(
        el("a", { href: `#/channel/${encodeURIComponent(channelHash)}` }, `← ${detail.channelName}`),
      );
      heading.appendChild(title);

      const copyBtn = el(
        "button",
        {
          className: "secondary",
          type: "button",
          "aria-label": `Copy link to message ${txHash}`,
        },
        "⧉ Copy link",
      ) as HTMLButtonElement;
      copyBtn.addEventListener("click", async () => {
        copyBtn.disabled = true;
        try {
          await copyMessageLink(channelHash, txHash);
          toast("Message link copied.", "ok");
        } catch (error) {
          toast(
            `Could not copy message link: ${error instanceof Error ? error.message : String(error)}`,
            "err",
          );
        } finally {
          copyBtn.disabled = false;
        }
      });
      heading.appendChild(copyBtn);
      container.appendChild(heading);

      container.appendChild(
        el(
          "p",
          { className: "muted" },
          "Decoded directly from this transaction; channel history length does not affect this page.",
        ),
      );

      const statusClass = detail.transactionStatus === "committed"
        ? "ok"
        : detail.transactionStatus === "rejected" ? "err" : "pending";
      const meta = el("div", { className: "row message-detail-summary" });
      meta.appendChild(el("span", { className: `col ${statusClass}` }, detail.transactionStatus));
      meta.appendChild(el("span", { className: "col" }, formatTime(message.timestamp)));
      if (message.blockNumber !== undefined) {
        meta.appendChild(el("span", { className: "col" }, `block #${message.blockNumber}`));
      }
      container.appendChild(meta);

      container.appendChild(el("label", {}, "Author"));
      const author = el("pre", {}, message.author);
      author.style.overflowWrap = "anywhere";
      author.style.whiteSpace = "pre-wrap";
      container.appendChild(author);

      container.appendChild(el("label", {}, "Message"));
      const payload = el("div", { className: "message-detail-payload" }, message.payload);
      container.appendChild(payload);

      const capacity = el("div", { className: "row message-detail-capacity" });
      capacity.appendChild(el("span", { className: "col" }, `Before: ${formatCapacity(message.inputCapacity)}`));
      capacity.appendChild(el("span", { className: "col" }, `After: ${formatCapacity(message.outputCapacity)}`));
      capacity.appendChild(el("span", { className: "col" }, `Delta: ${formatCapacityDelta(message.capacityDelta)}`));
      container.appendChild(capacity);

      container.appendChild(el("label", {}, "Channel hash"));
      container.appendChild(el("pre", {}, channelHash));
      container.appendChild(el("label", {}, "Transaction"));
      container.appendChild(
        el(
          "p",
          {},
          el("a", { href: `${EXPLORER_TX_URL}${txHash}`, target: "_blank" }, txHash),
        ),
      );
    } catch (error) {
      if (cancelled) return;
      container.innerHTML = "";
      container.appendChild(el("h2", { className: "err" }, "Message unavailable"));
      container.appendChild(
        el("p", { className: "err" }, error instanceof Error ? error.message : String(error)),
      );
      container.appendChild(
        el("a", { href: `#/channel/${encodeURIComponent(channelHash)}` }, "← Back to channel"),
      );
    }
  }

  void render();
  return () => {
    cancelled = true;
  };
}
