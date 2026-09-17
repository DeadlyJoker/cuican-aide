import type { SoakDesktopState } from "./protocol.ts";
import {
  verifySoakInFlightTurn,
  type soakReadClient,
} from "./turn-evidence.ts";

/** Reload only the isolated renderer while the model holds the second tool response. */
export async function verifyRendererRecovery(input: {
  marker: string;
  client: ReturnType<typeof soakReadClient>;
  control<T>(action: string, input?: Record<string, unknown>): Promise<T>;
  pause(ms: number): Promise<void>;
  generations(): number;
}) {
  const before = await input.control<SoakDesktopState>("state");
  const selected = before.renderer.threads.find((thread) => thread.selected);
  if (!selected) throw new Error("soak_recovery_thread_missing");
  const inFlight = await verifySoakInFlightTurn(
    input.client,
    selected.id,
    input.marker,
  );
  const generations = input.generations();
  await input.control("reload");
  const deadline = Date.now() + 15000;
  let after: SoakDesktopState | null = null;
  while (Date.now() < deadline) {
    await input.pause(250);
    const state = await input.control<SoakDesktopState>("state");
    if (
      state.renderer.timeOrigin !== before.renderer.timeOrigin &&
      state.renderer.composer
    ) {
      after = state;
      break;
    }
  }
  if (!after || !Number.isFinite(after.renderer.timeOrigin))
    throw new Error("soak_reload_not_ready");
  if (
    !after.renderer.threads.some(
      (thread) => thread.id === selected.id && thread.selected,
    )
  )
    throw new Error("soak_reload_selection_lost");
  const restored = await verifySoakInFlightTurn(
    input.client,
    selected.id,
    input.marker,
  );
  if (
    restored.runId !== inFlight.runId ||
    restored.userMessageId !== inFlight.userMessageId ||
    input.generations() !== generations
  )
    throw new Error("soak_reload_duplicate_execution");
  return {
    ...inFlight,
    threadId: selected.id,
    beforeTimeOrigin: before.renderer.timeOrigin,
    afterTimeOrigin: after.renderer.timeOrigin,
    generationsBefore: generations,
    generationsAfter: input.generations(),
  };
}
