import { el, navBar, toast } from "./common";

const INSTALL_COMMAND = [
  'mkdir -p "$HOME/.agents/skills"',
  'unzip -o "$HOME/Downloads/comp-shared-lock-skill.zip" -d "$HOME/.agents/skills"',
].join(" && ");

const STARTER_PROMPT =
  "Use $comp-shared-lock to list the live COMP channels on CKB testnet.";

async function copy(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast(`${label} copied`, "ok");
  } catch {
    toast("Copy failed. Select the command manually.", "err");
  }
}

function commandCard(title: string, value: string, buttonLabel: string): HTMLElement {
  const card = el("div", { className: "card" });
  card.appendChild(el("h3", {}, title));
  card.appendChild(el("pre", {}, value));
  const button = el("button", { type: "button", className: "secondary" }, buttonLabel);
  button.addEventListener("click", () => void copy(value, title));
  card.appendChild(button);
  return card;
}

export function aiSkillView(): void {
  const app = document.getElementById("app")!;
  app.innerHTML = "";
  app.appendChild(navBar());

  const intro = el("main", { className: "card" });
  intro.appendChild(el("h2", {}, "Use COMP with AI"));
  intro.appendChild(
    el(
      "p",
      {},
      "This skill runs a bundled local CLI that talks directly to CKB testnet. No COMP backend, MCP server, repository checkout, or AI browser control is required.",
    ),
  );
  intro.appendChild(
    el(
      "p",
      { className: "muted" },
      "Requires Node.js 20+. Queries run directly; anonymous messages use a draft → confirmation → send workflow.",
    ),
  );
  intro.appendChild(
    el(
      "a",
      {
        className: "download-button",
        href: new URL("downloads/comp-shared-lock-skill.zip", document.baseURI).toString(),
        download: "comp-shared-lock-skill.zip",
      },
      "Download AI Skill",
    ),
  );
  app.appendChild(intro);

  app.appendChild(commandCard("Install", INSTALL_COMMAND, "Copy install command"));
  app.appendChild(commandCard("Try it", STARTER_PROMPT, "Copy starter prompt"));

  const capabilities = el("section", { className: "card" });
  capabilities.appendChild(el("h3", {}, "What the AI can do"));
  const list = el("ul", {});
  list.appendChild(el("li", {}, "List channels and inspect capacity."));
  list.appendChild(el("li", {}, "Read and summarize confirmed messages."));
  list.appendChild(el("li", {}, "Check CKB transaction status and fees."));
  list.appendChild(el("li", {}, "Draft an anonymous message and send only after your confirmation."));
  capabilities.appendChild(list);
  capabilities.appendChild(
    el(
      "p",
      { className: "muted" },
      "Creating channels and adding funded Cells still finish in the wallet UI; the AI receives no wallet secrets.",
    ),
  );
  app.appendChild(capabilities);
}
