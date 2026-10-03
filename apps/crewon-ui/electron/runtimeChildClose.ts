import type { ChildProcess } from "node:child_process";

type Exit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;
type OwnedChild = {
  closed: boolean;
  result: Exit | null;
};
const owned = new WeakMap<ChildProcess, OwnedChild>();

/** Register immediately after spawn, before callers can observe exit or retire input files. */
export function observeRuntimeChildClose(child: ChildProcess): void {
  if (owned.has(child)) return;
  const state: OwnedChild = { closed: false, result: null };
  owned.set(child, state);
  child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
    state.result = { code, signal };
    state.closed = true;
  });
}

/** Spawned Native children remain owned until their stdio has also closed. */
export function isRuntimeChildTerminal(child: ChildProcess): boolean {
  const state = owned.get(child);
  return state === undefined
    ? child.exitCode !== null || child.signalCode !== null
    : state.closed;
}

/** Existing injected child ports retain their exit contract; actual Native spawns await close. */
export function waitForRuntimeChildTerminalBefore(
  child: ChildProcess,
  timeoutMs: number,
): Promise<Exit | null> {
  const state = owned.get(child);
  if (isRuntimeChildTerminal(child))
    return Promise.resolve(
      state?.result ?? { code: child.exitCode, signal: child.signalCode },
    );
  return new Promise((resolve) => {
    const event = state === undefined ? "exit" : "close";
    let settled = false;
    const finish = (result: Exit | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off(event, onTerminal);
      child.off("error", onError);
      resolve(result);
    };
    const onTerminal = (code: number | null, signal: NodeJS.Signals | null) =>
      finish({ code, signal });
    // Native spawn failures also emit close. An error alone does not close its pipes.
    const onError = () => {
      if (state === undefined)
        finish({ code: child.exitCode, signal: child.signalCode });
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.once(event, onTerminal);
    child.once("error", onError);
  });
}
