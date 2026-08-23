export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

export function el(tag: string, attrs?: Record<string, string>, ...children: (Node | string)[]): HTMLElement {
  const element = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "className") {
        element.className = value;
      } else {
        element.setAttribute(key, value);
      }
    }
  }
  for (const child of children) {
    if (typeof child === "string") {
      element.appendChild(document.createTextNode(child));
    } else if (child) {
      element.appendChild(child);
    }
  }
  return element;
}

export function toast(message: string, cls = "") {
  const container = document.getElementById("toast");
  if (!container) return;
  const item = document.createElement("div");
  item.className = `toast-item ${cls}`;
  item.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  container.appendChild(item);
  setTimeout(() => item.remove(), 6000);
}

export function navBar(): HTMLElement {
  const bar = el("div", { className: "nav" });
  bar.appendChild(el("a", { href: "#/" }, "COMP SPACES"));
  bar.appendChild(el("span", { className: "muted" }, "CKB Testnet"));
  const spacer = el("span", {});
  spacer.style.flex = "1";
  bar.appendChild(spacer);
  bar.appendChild(el("a", { href: "#/channels/new" }, "New Text Room"));
  bar.appendChild(el("a", { href: "#/walls/new" }, "New Wall"));
  return bar;
}

export function spinner(text = "loading…"): HTMLElement {
  return el("div", { className: "card muted" }, text);
}

export function link(href: string, text: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = href;
  a.textContent = text;
  return a;
}

export function formatTime(timestamp?: bigint): string {
  if (timestamp === undefined) return "pending";
  return new Date(Number(timestamp)).toLocaleString();
}
