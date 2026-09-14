import { randomUUID } from "node:crypto";
import { ipcMain, type WebContents } from "electron";

/** Bounded isolated-preload handshake. Unavailable/late checks always reject pixels. */
export class RecordingScreenshotVerifier {
  readonly #pending = new Map<
    string,
    {
      contents: WebContents;
      generation: string;
      resolve: (safe: boolean) => void;
    }
  >();
  constructor(readonly currentGeneration: () => string | null) {
    ipcMain.on(
      "crewon:recording:screenshot-verified",
      (event, payload: unknown) => {
        if (!payload || typeof payload !== "object") return;
        const input = payload as {
          requestId?: unknown;
          generation?: unknown;
          safe?: unknown;
        };
        if (typeof input.requestId !== "string") return;
        const pending = this.#pending.get(input.requestId);
        if (!pending) return;
        if (
          event.sender !== pending.contents ||
          event.senderFrame !== pending.contents.mainFrame
        )
          return;
        pending.resolve(
          input.safe === true &&
            input.generation === pending.generation &&
            this.currentGeneration() === pending.generation,
        );
      },
    );
  }
  verify(
    contents: WebContents,
    generation: string,
    selector: string,
  ): Promise<boolean> {
    if (
      this.#pending.size >= 2 ||
      contents.isDestroyed() ||
      this.currentGeneration() !== generation
    )
      return Promise.resolve(false);
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const finish = (safe: boolean) => {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        resolve(safe);
      };
      const timer = setTimeout(() => finish(false), 500);
      this.#pending.set(requestId, { contents, generation, resolve: finish });
      contents.send("crewon:recording:verify-screenshot", {
        requestId,
        generation,
        selector,
      });
    });
  }
}
