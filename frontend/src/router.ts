import { chatRoomView } from "./views/chatRoom";
import { addCellView } from "./views/addCell";
import { createChannelView } from "./views/createChannel";
import { messageDetailView } from "./views/messageDetail";
import { wallExplorerView } from "./views/wallExplorer";
import { wallView } from "./views/wall";
import { pkBoardView } from "./views/pkBoard";

export interface Route {
  name: string;
  params: Record<string, string>;
}

interface RouteDefinition {
  pattern: RegExp;
  name: string;
  keys?: string[];
  render: (params: Record<string, string>) => void;
}

const routes: RouteDefinition[] = [
  { pattern: /^\/$/, name: "wallExplorer", render: () => wallExplorerView() },
  { pattern: /^\/walls\/new$/, name: "createWall", render: () => createChannelView("wall") },
  { pattern: /^\/channels\/new$/, name: "createChannel", render: () => createChannelView("chat") },
  {
    pattern: /^\/wall\/([^/]+)$/,
    name: "wall",
    keys: ["hash"],
    render: (p) => wallView(p.hash),
  },
  {
    pattern: /^\/channel\/([^/]+)\/message\/([^/]+)$/,
    name: "sharedMessage",
    keys: ["hash", "txHash"],
    render: (p) => messageDetailView(p.hash, p.txHash),
  },
  {
    pattern: /^\/channel\/([^/]+)\/add-cell$/,
    name: "addCell",
    keys: ["hash"],
    render: (p) => addCellView(p.hash),
  },
  {
    pattern: /^\/pk\/([^/]+)\/([^/]+)$/,
    name: "pkBoard",
    keys: ["a", "b"],
    render: (p) => pkBoardView(p.a, p.b),
  },
  {
    pattern: /^\/channel\/([^/]+)$/,
    name: "chatRoom",
    keys: ["hash"],
    render: (p) => chatRoomView(p.hash),
  },
];

let currentCleanup: (() => void) | undefined;

function matchRoute(path: string): { route: typeof routes[number]; params: Record<string, string> } | undefined {
  for (const route of routes) {
    const m = path.match(route.pattern);
    if (m) {
      const params: Record<string, string> = {};
      m.slice(1).forEach((value, i) => {
        const key = route.keys?.[i];
        if (key) params[key] = decodeURIComponent(value);
      });
      return { route, params };
    }
  }
  return undefined;
}

export function getRoute(): Route {
  const hash = location.hash.replace(/^#/, "") || "/";
  const matched = matchRoute(hash);
  if (!matched) return { name: "notFound", params: {} };
  return { name: matched.route.name, params: matched.params };
}

export function navigate(path: string) {
  location.hash = `#${path}`;
}

function renderRoute() {
  if (currentCleanup) {
    try {
      currentCleanup();
    } catch {
      // ignore cleanup errors
    }
    currentCleanup = undefined;
  }

  const hash = location.hash.replace(/^#/, "") || "/";
  const matched = matchRoute(hash);
  const app = document.getElementById("app")!;

  if (!matched) {
    app.innerHTML = `
      <div class="card">
        <h2>404</h2>
        <p>Page not found.</p>
        <a href="#/">← Back to channels</a>
      </div>
    `;
    return;
  }

  app.innerHTML = "";
  const cleanup = matched.route.render(matched.params);
  if (typeof cleanup === "function") {
    currentCleanup = cleanup;
  }
}

export function initRouter() {
  window.addEventListener("hashchange", renderRoute);
  renderRoute();
}
