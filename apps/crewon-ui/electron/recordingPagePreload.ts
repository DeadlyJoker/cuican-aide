import { ipcRenderer } from "electron";
import { installRecordingSource } from "./recordingSource.ts";

// This preload executes in the isolated world. It deliberately exposes no API to
// the remote page and never listens to page messages or custom DOM events.
let generation: string | null = null;
const source = installRecordingSource({
  document,
  window,
  emit(event) {
    if (generation !== null) {
      ipcRenderer.send("crewon:recording:event", { generation, event });
    }
  },
});

ipcRenderer.on("crewon:recording:arm", (_event, payload: unknown) => {
  const next =
    payload && typeof payload === "object" && "generation" in payload
      ? payload.generation
      : null;
  if (typeof next !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(next)) {
    generation = null;
    source.setEnabled(false);
    return;
  }
  // Repeated readiness events must not reset mutation-bound screenshot candidates.
  if (next === generation) {
    ipcRenderer.send("crewon:recording:armed", generation);
    return;
  }
  generation = null;
  source.setEnabled(false);
  generation = next;
  source.setEnabled(true);
  ipcRenderer.send("crewon:recording:armed", generation);
});

ipcRenderer.on(
  "crewon:recording:verify-screenshot",
  (_event, payload: unknown) => {
    if (
      !generation ||
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    )
      return;
    const data = payload as Record<string, unknown>;
    if (
      Object.keys(data).sort().join(",") !== "generation,requestId,selector" ||
      data.generation !== generation ||
      typeof data.requestId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(data.requestId) ||
      typeof data.selector !== "string" ||
      data.selector.length > 512
    )
      return;
    ipcRenderer.send("crewon:recording:screenshot-verified", {
      requestId: data.requestId,
      generation,
      safe: source.verifyScreenshot(data.selector),
    });
  },
);

window.addEventListener("pagehide", () => {
  generation = null;
  source.setEnabled(false);
});
