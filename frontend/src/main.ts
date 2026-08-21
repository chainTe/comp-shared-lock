import { loadDeployment } from "./config";
import { initRouter } from "./router";
import { toast } from "./views/common";

async function bootstrap() {
  try {
    await loadDeployment();
    initRouter();
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    document.getElementById("app")!.innerHTML = `
      <div class="card err">
        <h3>Failed to start</h3>
        <p>${err}</p>
        <p class="muted">Make sure deployment.json exists at the project root.</p>
      </div>
    `;
    toast(err, "err");
  }
}

void bootstrap();
