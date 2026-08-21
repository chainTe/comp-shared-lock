import { channelListView } from "./views/channelList";
import { chatRoomView } from "./views/chatRoom";
import { addCellView } from "./views/addCell";
import { createChannelView } from "./views/createChannel";

export interface Route {
  name: string;
  params: Record<string, string>;
}

const routes: { pattern: RegExp; name: string; render: (params: Record<string, string>) => void }[] = [
  { pattern: /^\/$/, name: "channelList", render: () => channelListView() },
  { pattern: /^\/channels\/new$/, name: "createChannel", render: () => createChannelView() },
  { pattern: /^\/channel\/([^/]+)$/, name: "chatRoom", render: (p) => chatRoomView(p.hash) },
  { pattern: /^\/channel\/([^/]+)\/add-cell$/, name: "addCell", render: (p) => addCellView(p.hash) },
];

let currentCleanup: (() => void) | undefined;

function matchRoute(path: string): { route: typeof routes[number]; params: Record<string, string> } | undefined {
  for (const route of routes) {
    const m = path.match(route.pattern);
    if (m) {
      const params: Record<string, string> = {};
      const keys = ["hash"];
      m.slice(1).forEach((value, i) => {
        if (keys[i]) params[keys[i]] = decodeURIComponent(value);
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
