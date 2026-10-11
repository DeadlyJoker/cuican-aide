import { spawn } from "node:child_process";

const stoppedChildren = new WeakMap();
const ownedGroups = new WeakMap();

/** POSIX services own an isolated group, including pnpm/Vite descendants. */
export function spawnDevelopmentChild(name, command, args, options) {
  const processGroup = process.platform !== "win32";
  const child = spawn(command, args, { ...options, detached: processGroup });
  if (processGroup && child.pid !== undefined)
    ownedGroups.set(child, child.pid);
  child.once("error", (error) => {
    process.stderr.write(`${name} failed to start: ${error.message}\n`);
  });
  // Windows keeps its existing direct-child behavior: Node has no POSIX groups there.
  return { child, name, processGroup };
}

/** Includes an exit that happened between readiness and supervisor registration. */
export function waitDevelopmentChildExit({ child, name }) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      name,
      signal: child.signalCode,
    });
  }
  if (child.pid === undefined) {
    return Promise.resolve({ code: 1, name, signal: null });
  }
  return new Promise((resolveExit) => {
    const finish = (code, signal) => {
      child.off("exit", exited);
      child.off("error", failed);
      resolveExit({ code, name, signal });
    };
    const exited = (code, signal) => finish(code, signal);
    const failed = () => finish(1, null);
    child.once("exit", exited);
    child.once("error", failed);
  });
}

/** Finish every owned cleanup before reporting partial failure. Never discover other PIDs. */
export async function stopDevelopmentChildren(
  children,
  { graceMs = 5000 } = {},
) {
  if (!Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > 5000)
    throw new Error("development_child_cleanup_grace_invalid");
  const results = await Promise.allSettled(
    children.map((managed) => {
      let stopping = stoppedChildren.get(managed.child);
      if (stopping === undefined) {
        stopping = stopChild(managed, graceMs);
        stoppedChildren.set(managed.child, stopping);
      }
      return stopping;
    }),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "development_child_cleanup_failed",
    );
}

async function stopChild({ child, name }, graceMs) {
  if (child.pid === undefined) return;
  const groupPid = ownedGroups.get(child);
  if (groupPid !== undefined) {
    // A wrapper can already have exited while its owned grandchildren remain alive.
    if (!signalGroup(groupPid, "SIGTERM")) return;
    if (await waitGroupGone(groupPid, graceMs)) return;
    signalGroup(groupPid, "SIGKILL");
    if (!(await waitGroupGone(groupPid, 1000)))
      throw new Error(`development_child_cleanup_timeout:${name}`);
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitDevelopmentChildExit({ child, name });
  let timer;
  try {
    child.kill("SIGTERM");
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), graceMs);
      }),
    ]);
    if (graceful) return;
    child.kill("SIGKILL");
    clearTimeout(timer);
    if (
      !(await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 1000);
        }),
      ]))
    )
      throw new Error(`development_child_cleanup_timeout:${name}`);
  } finally {
    clearTimeout(timer);
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // macOS may report EPERM for an existing group containing only un-reaped
    // processes. Keep waiting within the deadline; it does not authorize a kill.
    if (signal === 0 && error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitGroupGone(pid, deadlineMs) {
  const deadline = performance.now() + deadlineMs;
  for (;;) {
    if (!signalGroup(pid, 0)) return true;
    if (performance.now() >= deadline) return false;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(25, deadline - performance.now())),
    );
  }
}

/** A signal or any service exit closes all managed services before the launcher settles. */
export async function superviseDevelopmentChildren(children, { signal } = {}) {
  let notifySignal;
  const stoppedBySignal = new Promise((resolve) => {
    notifySignal = resolve;
  });
  const interrupt = () => notifySignal({ kind: "signal" });
  // Repeated stop signals must not abort an in-progress descendant cleanup.
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  signal?.addEventListener("abort", interrupt);
  if (signal?.aborted) interrupt();
  try {
    const result = await Promise.race([
      stoppedBySignal,
      ...children.map(async (managed) => ({
        kind: "exit",
        ...(await waitDevelopmentChildExit(managed)),
      })),
    ]);
    await stopDevelopmentChildren(children);
    if (result.kind === "exit")
      throw new Error(
        `${result.name} exited unexpectedly (${result.signal ?? result.code ?? "unknown"})`,
      );
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    signal?.removeEventListener("abort", interrupt);
  }
}

/** Keep cancellation protection active through readiness and partial-startup cleanup. */
export async function withDevelopmentChildLifecycle({ children, start }) {
  const startup = new AbortController();
  const cancelStartup = () => startup.abort();
  process.on("SIGINT", cancelStartup);
  process.on("SIGTERM", cancelStartup);
  try {
    await start({ signal: startup.signal });
    await superviseDevelopmentChildren(children, { signal: startup.signal });
  } catch (error) {
    await stopDevelopmentChildren(children);
    throw error;
  } finally {
    process.off("SIGINT", cancelStartup);
    process.off("SIGTERM", cancelStartup);
  }
}
