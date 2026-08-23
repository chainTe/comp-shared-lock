import { ccc } from "@ckb-ccc/shell";
import {
  createChannelWithSigner,
  MAX_INITIAL_CELL_COUNT,
  minimumCompCellCapacity,
  normalizeCellCount,
} from "../cellManager";
import {
  channelHashFromName,
  channelMetadata,
  encodeChannelMetadata,
  rememberChannelName,
} from "../channelNames";
import {
  connectWallet,
  disconnectWallet,
  getConnectedWalletAddress,
  getWalletSigner,
} from "../identity";
import { EXPLORER_TX_URL } from "../rpc";
import type { ChannelKind } from "../types";
import { el, navBar, toast } from "./common";

export function createChannelView(initialKind: ChannelKind = "wall"): () => void {
  const app = document.getElementById("app")!;
  app.innerHTML = "";
  app.appendChild(navBar());

  let cancelled = false;
  let signer = getWalletSigner();

  const intro = el("div", { className: "card" });
  const introTitle = el("h2", {});
  const introCopy = el("p", { className: "muted" });
  intro.appendChild(introTitle);
  intro.appendChild(introCopy);
  app.appendChild(intro);

  const form = el("div", { className: "card" });
  form.appendChild(el("label", { for: "channel-kind" }, "Space format"));
  const kindSelect = el("select", { id: "channel-kind" }) as HTMLSelectElement;
  kindSelect.appendChild(el("option", { value: "wall" }, "Canvas wall — draw together") as HTMLOptionElement);
  kindSelect.appendChild(el("option", { value: "chat" }, "Text room — talk together") as HTMLOptionElement);
  kindSelect.value = initialKind;
  form.appendChild(kindSelect);

  const nameLabel = el("label", { for: "channel-name" });
  form.appendChild(nameLabel);
  const nameInput = el("input", {
    id: "channel-name",
    type: "text",
    maxlength: "64",
    placeholder: "CKB Summit 2026",
    autocomplete: "off",
  }) as HTMLInputElement;
  form.appendChild(nameInput);

  form.appendChild(el("label", {}, "Deterministic identifier"));
  const slugPreview = el("pre", { id: "channel-slug", className: "muted" }, "comp-channel-…");
  form.appendChild(slugPreview);

  form.appendChild(el("label", {}, "Channel hash"));
  const hashPreview = el("pre", { id: "channel-hash" }, "Enter a channel name");
  hashPreview.style.overflowWrap = "anywhere";
  hashPreview.style.whiteSpace = "pre-wrap";
  form.appendChild(hashPreview);

  const valueRow = el("div", { className: "row" });
  const capacityCol = el("div", { className: "col" });
  const capacityLabel = el("label", { for: "channel-capacity" });
  capacityCol.appendChild(capacityLabel);
  const capacityInput = el("input", {
    id: "channel-capacity",
    type: "number",
    value: "200",
    min: "1",
    step: "0.00000001",
  }) as HTMLInputElement;
  capacityCol.appendChild(capacityInput);
  const capacityHint = el("div", { className: "muted" }, "Minimum depends on channel metadata.");
  capacityHint.style.fontSize = "0.8rem";
  capacityHint.style.marginTop = "0.35rem";
  capacityCol.appendChild(capacityHint);

  const countCol = el("div", { className: "col" });
  const countLabel = el("label", { for: "channel-cell-count" });
  countCol.appendChild(countLabel);
  const cellCountInput = el("input", {
    id: "channel-cell-count",
    type: "number",
    value: "4",
    min: "1",
    max: String(MAX_INITIAL_CELL_COUNT),
    step: "1",
    inputmode: "numeric",
  }) as HTMLInputElement;
  countCol.appendChild(cellCountInput);
  const countHint = el("div", { className: "muted" }, "Creates 1 Cell.");
  countHint.style.fontSize = "0.8rem";
  countHint.style.marginTop = "0.35rem";
  countCol.appendChild(countHint);

  const feeCol = el("div", { className: "col" });
  feeCol.appendChild(el("label", { for: "channel-max-fee" }, "Maximum fee per post (CKB)"));
  const maxFeeInput = el("input", {
    id: "channel-max-fee",
    type: "number",
    value: "0.01",
    min: "0.00000001",
    step: "0.00000001",
  }) as HTMLInputElement;
  feeCol.appendChild(maxFeeInput);

  valueRow.appendChild(capacityCol);
  valueRow.appendChild(countCol);
  valueRow.appendChild(feeCol);
  form.appendChild(valueRow);

  const walletStatus = el("p", { className: "muted" });
  form.appendChild(walletStatus);

  const actions = el("div", { className: "row" });
  const connectBtn = el("button", { className: "col secondary" }, "Connect Wallet") as HTMLButtonElement;
  const submitBtn = el("button", { className: "col" }) as HTMLButtonElement;
  actions.appendChild(connectBtn);
  actions.appendChild(submitBtn);
  form.appendChild(actions);
  app.appendChild(form);

  function selectedKind(): ChannelKind {
    return kindSelect.value === "chat" ? "chat" : "wall";
  }

  function renderKindCopy(): void {
    const isChat = selectedKind() === "chat";
    introTitle.textContent = isChat ? "Create a Text Room" : "Create a Wall";
    introCopy.textContent = isChat
      ? "Start a public text room with a shared Message Supply. Multiple COMP Cells become parallel message lanes so anyone can talk without holding CKB."
      : "Name a public canvas and add its first Paint Supply. Multiple COMP Cells become parallel paint lanes so everyone can post without holding CKB.";
    nameLabel.textContent = isChat ? "Room name" : "Wall name";
    nameInput.placeholder = isChat ? "General" : "CKB Summit 2026";
    capacityLabel.textContent = isChat ? "Messages per lane (CKB)" : "Paint per lane (CKB)";
    countLabel.textContent = isChat ? "Parallel message lanes" : "Parallel paint lanes";
  }

  function preview(): { name: string; hash: string; cellCount: number; kind: ChannelKind } | undefined {
    renderKindCopy();
    const kind = selectedKind();
    let definition: { name: string; hash: string };
    try {
      const metadata = channelMetadata(nameInput.value, kind);
      const hash = channelHashFromName(metadata.name);
      const outputData = encodeChannelMetadata(metadata.name, kind);
      const minimum = minimumCompCellCapacity(outputData);
      slugPreview.textContent = `comp-channel-${metadata.slug}`;
      hashPreview.textContent = hash;
      hashPreview.className = "ok";
      capacityInput.min = ccc.fixedPointToString(minimum);
      capacityHint.textContent = `Minimum ${ccc.fixedPointToString(minimum)} CKB (${ccc.bytesFrom(outputData).length} bytes of on-chain metadata).`;
      definition = { name: metadata.name, hash };
    } catch (e) {
      slugPreview.textContent = "comp-channel-…";
      hashPreview.textContent = nameInput.value
        ? e instanceof Error ? e.message : String(e)
        : "Enter a channel name";
      hashPreview.className = nameInput.value ? "err" : "muted";
      capacityHint.textContent = "Minimum depends on channel metadata.";
      return;
    }

    try {
      const cellCount = normalizeCellCount(cellCountInput.value);
      const capacity = ccc.fixedPointFrom(capacityInput.value);
      const totalCapacity = capacity * BigInt(cellCount);
      const maxFee = ccc.fixedPointFrom(maxFeeInput.value);
      const estimatedPosts = maxFee > 0n ? totalCapacity / maxFee : 0n;
      const laneKind = kind === "chat" ? "message" : "paint";
      countHint.textContent = `Creates ${cellCount} ${laneKind} ${cellCount === 1 ? "lane" : "lanes"}; ${ccc.fixedPointToString(totalCapacity)} CKB total · up to ~${estimatedPosts.toLocaleString()} posts at the fee ceiling.`;
      countHint.className = "muted";
      const noun = kind === "chat" ? "Text Room" : "Wall";
      submitBtn.textContent = cellCount === 1
        ? `Create ${noun}`
        : `Create ${noun} with ${cellCount} lanes`;
      return { ...definition, cellCount, kind };
    } catch (e) {
      countHint.textContent = e instanceof Error ? e.message : String(e);
      countHint.className = "err";
      return;
    }
  }

  function renderWallet() {
    signer = getWalletSigner();
    const address = getConnectedWalletAddress();
    walletStatus.textContent = signer && address
      ? `Wallet: ${address}`
      : "Connect a funded CKB testnet wallet to create the Cell.";
    walletStatus.className = signer ? "ok" : "muted";
    connectBtn.textContent = signer ? "Disconnect Wallet" : "Connect Wallet";
  }

  nameInput.addEventListener("input", preview);
  kindSelect.addEventListener("change", preview);
  capacityInput.addEventListener("input", preview);
  cellCountInput.addEventListener("input", preview);
  maxFeeInput.addEventListener("input", preview);

  connectBtn.addEventListener("click", async () => {
    if (getWalletSigner()) {
      disconnectWallet();
      renderWallet();
      return;
    }
    await connectWallet("transaction");
    if (!cancelled) renderWallet();
  });

  submitBtn.addEventListener("click", async () => {
    const definition = preview();
    signer = getWalletSigner();
    if (!definition) {
      toast("Check the channel name, capacity, and Cell count.", "err");
      return;
    }
    if (!signer) {
      toast("Connect a CKB testnet wallet first.", "err");
      return;
    }

    submitBtn.disabled = true;
    connectBtn.disabled = true;
    submitBtn.textContent = "Creating…";
    try {
      const result = await createChannelWithSigner(
        signer,
        definition.name,
        capacityInput.value,
        maxFeeInput.value,
        definition.cellCount,
        definition.kind,
      );
      rememberChannelName(result.channelHash, definition.name);
      toast(`${result.cellCount} channel ${result.cellCount === 1 ? "Cell" : "Cells"} submitted: ${result.txHash.slice(0, 16)}…`, "ok");

      form.innerHTML = "";
      form.appendChild(
        el(
          "h3",
          { className: "ok" },
          `${definition.kind === "chat" ? "Text room" : "Wall"} submitted with ${result.cellCount} ${definition.kind === "chat" ? "message" : "paint"} ${result.cellCount === 1 ? "lane" : "lanes"}`,
        ),
      );
      form.appendChild(el("p", {}, `${definition.name} will appear in Space Explorer after testnet confirmation.`));
      form.appendChild(el("label", {}, "Channel hash"));
      form.appendChild(el("pre", {}, result.channelHash));
      form.appendChild(
        el(
          "p",
          {},
          "Transaction: ",
          el("a", { href: `${EXPLORER_TX_URL}${result.txHash}`, target: "_blank" }, result.txHash),
        ),
      );
      const successActions = el("div", { className: "row" });
      successActions.appendChild(el("a", { href: "#/" }, "← Back to channels"));
      successActions.appendChild(
        el(
          "a",
          { href: `${definition.kind === "chat" ? "#/channel" : "#/wall"}/${encodeURIComponent(result.channelHash)}` },
          `Open ${definition.kind === "chat" ? "room" : "wall"} after confirmation →`,
        ),
      );
      form.appendChild(successActions);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "err");
      submitBtn.disabled = false;
      connectBtn.disabled = false;
      preview();
    }
  });

  preview();
  renderWallet();

  return () => {
    cancelled = true;
  };
}
