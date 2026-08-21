import { discoverChannels } from "../resolver";
import { readCachedChannels } from "../scanCache";
import type { Channel } from "../types";
import { formatCapacity, truncateHash } from "../utils";
import { el, navBar, spinner, toast } from "./common";

export function channelListView(): () => void {
  const app = document.getElementById("app")!;
  app.innerHTML = "";
  app.appendChild(navBar());

  const header = el("div", { className: "card" });
  const titleRow = el("div", { className: "row" });
  titleRow.appendChild(el("h2", { className: "col" }, "Channels"));
  titleRow.appendChild(
    el("a", { href: "#/channels/new", className: "action-link" }, "+ Create Channel"),
  );
  header.appendChild(titleRow);
  header.appendChild(el("p", { className: "muted" }, "Discover all COMP Shared Lock channels on CKB testnet."));
  app.appendChild(header);

  const listContainer = el("div", {});
  app.appendChild(listContainer);
  const cached = readCachedChannels();
  listContainer.appendChild(
    spinner(cached ? "showing saved scan while checking for updates…" : "scanning chain for COMP cells…"),
  );

  let cancelled = false;

  function renderChannels(channels: Channel[], savedAt?: number, checking = false) {
    listContainer.innerHTML = "";

    if (savedAt !== undefined) {
      listContainer.appendChild(
        el(
          "p",
          { className: "muted" },
          checking
            ? `Saved scan from ${new Date(savedAt).toLocaleString()} · checking chain once for updates…`
            : `Live scan completed ${new Date(savedAt).toLocaleString()} · saved locally`,
        ),
      );
    }

    if (channels.length === 0) {
      listContainer.appendChild(
        el("div", { className: "card muted" }, "No COMP channels found."),
      );
      return;
    }

    for (const channel of channels) {
      const card = el("a", {
        href: `#/channel/${encodeURIComponent(channel.hash)}`,
        className: "card",
      });
      card.style.display = "block";

      const titleRow = el("div", { className: "row" });
      titleRow.appendChild(el("h3", { className: "col" }, channel.name));
      titleRow.appendChild(
        el("span", { className: "col muted" }, `hash: ${truncateHash(channel.hash)}`),
      );
      card.appendChild(titleRow);

      const metaRow = el("div", { className: "row" });
      metaRow.appendChild(
        el("span", { className: "col" }, `capacity: ${formatCapacity(channel.totalCapacity)}`),
      );
      metaRow.appendChild(
        el("span", { className: "col" }, `cells: ${channel.cells.length}`),
      );
      metaRow.appendChild(
        el("span", { className: "col" }, `max fee: ${formatCapacity(channel.maxFee)}`),
      );
      card.appendChild(metaRow);

      listContainer.appendChild(card);
    }
  }

  if (cached) renderChannels(cached.value, cached.updatedAt, true);

  discoverChannels()
    .then((channels) => {
      if (cancelled) return;
      renderChannels(channels, Date.now());
    })
    .catch((e) => {
      if (cancelled) return;
      if (!cached) {
        listContainer.innerHTML = "";
        listContainer.appendChild(
          el("div", { className: "card err" }, `Error: ${e instanceof Error ? e.message : String(e)}`),
        );
      } else {
        listContainer.appendChild(
          el("p", { className: "err" }, "Live refresh failed; saved channels remain available."),
        );
      }
      toast(String(e), "err");
    });

  return () => {
    cancelled = true;
  };
}
