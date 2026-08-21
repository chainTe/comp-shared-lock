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
import { el, navBar, toast } from "./common";

export function createChannelView(): () => void {
  const app = document.getElementById("app")!;
  app.innerHTML = "";
  app.appendChild(navBar());

  let cancelled = false;
  let signer = getWalletSigner();

  const intro = el("div", { className: "card" });
  intro.appendChild(el("h2", {}, "Create Channel"));
  intro.appendChild(
    el(
      "p",
      { className: "muted" },
      "Create one or more COMP Cells for a new channel. Their capacity becomes the shared pool that pays message fees.",
    ),
  );
  app.appendChild(intro);

  const form = el("div", { className: "card" });
  form.appendChild(el("label", { for: "channel-name" }, "Channel name"));
  const nameInput = el("input", {
    id: "channel-name",
    type: "text",
    maxlength: "64",
    placeholder: "Gas Pool",
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
  capacityCol.appendChild(el("label", { for: "channel-capacity" }, "Capacity per Cell (CKB)"));
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
  countCol.appendChild(el("label", { for: "channel-cell-count" }, "Initial Cell count"));
  const cellCountInput = el("input", {
    id: "channel-cell-count",
    type: "number",
    value: "1",
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
  feeCol.appendChild(el("label", { for: "channel-max-fee" }, "Maximum fee per message (CKB)"));
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
  const submitBtn = el("button", { className: "col" }, "Create Channel Cell") as HTMLButtonElement;
  actions.appendChild(connectBtn);
  actions.appendChild(submitBtn);
  form.appendChild(actions);
  app.appendChild(form);

  function preview(): { name: string; hash: string; cellCount: number } | undefined {
    let definition: { name: string; hash: string };
    try {
      const metadata = channelMetadata(nameInput.value);
      const hash = channelHashFromName(metadata.name);
      const outputData = encodeChannelMetadata(metadata.name);
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
      countHint.textContent = `Creates ${cellCount} ${cellCount === 1 ? "Cell" : "Cells"}; total capacity ${ccc.fixedPointToString(totalCapacity)} CKB.`;
      countHint.className = "muted";
      submitBtn.textContent = cellCount === 1
        ? "Create Channel Cell"
        : `Create ${cellCount} Channel Cells`;
      return { ...definition, cellCount };
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
  capacityInput.addEventListener("input", preview);
  cellCountInput.addEventListener("input", preview);

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
      );
      rememberChannelName(result.channelHash, definition.name);
      toast(`${result.cellCount} channel ${result.cellCount === 1 ? "Cell" : "Cells"} submitted: ${result.txHash.slice(0, 16)}…`, "ok");

      form.innerHTML = "";
      form.appendChild(
        el(
          "h3",
          { className: "ok" },
          `${result.cellCount} Channel ${result.cellCount === 1 ? "Cell" : "Cells"} submitted`,
        ),
      );
      form.appendChild(el("p", {}, `${definition.name} will appear after testnet confirmation.`));
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
          { href: `#/channel/${encodeURIComponent(result.channelHash)}` },
          "Open channel after confirmation →",
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
