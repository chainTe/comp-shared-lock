import { addCellWithSigner } from "../cellManager";
import { connectWallet, disconnectWallet, getWalletSigner, isWalletConnected } from "../identity";
import { EXPLORER_TX_URL } from "../rpc";
import { truncateHash } from "../utils";
import { el, link, navBar, toast } from "./common";

export function addCellView(channelHash: string): () => void {
  const app = document.getElementById("app")!;
  app.innerHTML = "";
  app.appendChild(navBar());

  let cancelled = false;
  let signer = getWalletSigner();

  const card = el("div", { className: "card" });
  card.appendChild(el("h2", {}, "Add Cell"));
  card.appendChild(
    el("p", { className: "muted" }, `Channel hash: ${truncateHash(channelHash)}`),
  );
  app.appendChild(card);

  const form = el("div", { className: "card" });
  app.appendChild(form);

  function renderForm() {
    form.innerHTML = "";

    if (!signer) {
      const connectBtn = el("button", {}, "Connect Wallet") as HTMLButtonElement;
      connectBtn.addEventListener("click", async () => {
        const identity = await connectWallet("transaction");
        if (identity?.mode === "wallet") {
          signer = getWalletSigner();
          renderForm();
        }
      });
      form.appendChild(el("p", {}, "A connected wallet is required to create a new COMP cell."));
      form.appendChild(connectBtn);
      return;
    }

    form.appendChild(el("label", {}, "Capacity (CKB)"));
    const capacityInput = el("input", {
      type: "number",
      value: "100",
      min: "61",
    }) as HTMLInputElement;
    form.appendChild(capacityInput);

    form.appendChild(el("label", {}, "Max Fee (CKB)"));
    const maxFeeInput = el("input", {
      type: "number",
      value: "0.01",
      min: "0.00000001",
      step: "0.00000001",
    }) as HTMLInputElement;
    form.appendChild(maxFeeInput);

    const btnRow = el("div", { className: "row" });
    const submitBtn = el("button", { className: "col" }, "Add Cell") as HTMLButtonElement;
    const disconnectBtn = el("button", { className: "col secondary" }, "Disconnect") as HTMLButtonElement;

    submitBtn.addEventListener("click", async () => {
      if (!signer) return;
      submitBtn.disabled = true;
      try {
        const txHash = await addCellWithSigner(
          signer,
          channelHash,
          capacityInput.value,
          maxFeeInput.value,
        );
        toast(`cell created: ${txHash.slice(0, 16)}…`, "ok");
        form.innerHTML = "";
        form.appendChild(el("p", { className: "ok" }, "Cell created successfully."));
        form.appendChild(el("p", {}, "tx: ", el("a", { href: `${EXPLORER_TX_URL}${txHash}`, target: "_blank" }, txHash)));
        form.appendChild(
          el(
            "p",
            {},
            el("a", { href: `#/channel/${encodeURIComponent(channelHash)}` }, "← Back to channel"),
          ),
        );
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), "err");
        submitBtn.disabled = false;
      }
    });

    disconnectBtn.addEventListener("click", () => {
      disconnectWallet();
      signer = undefined;
      renderForm();
    });

    btnRow.appendChild(submitBtn);
    btnRow.appendChild(disconnectBtn);
    form.appendChild(btnRow);
  }

  renderForm();

  return () => {
    cancelled = true;
  };
}
