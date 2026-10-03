import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

type ProcessIdentity = Readonly<{ parentPid: number; started: string }>;
const execute = promisify(execFile);
async function processes(): Promise<Map<number, ProcessIdentity>> {
  const { stdout } = await execute("ps", ["-axo", "pid=,ppid=,lstart="], {
    maxBuffer: 1024 * 1024,
  });
  const result = new Map<number, ProcessIdentity>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (match)
      result.set(Number(match[1]), {
        parentPid: Number(match[2]),
        started: match[3].trim(),
      });
  }
  return result;
}

/** Observes the actual OS child tree, without replacing the formal Main's spawn or runtime owner. */
export function trackDesktopTestChildren(child: ChildProcess) {
  if (!child.pid) throw new Error("desktop_test_child_pid_missing");
  const pid = child.pid;
  const owned = new Map<number, ProcessIdentity>();
  let rootStarted: string | null = null;
  let pending: Promise<void> | null = null;
  const capture = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const current = await processes();
    const root = current.get(pid);
    if (!root || (rootStarted !== null && rootStarted !== root.started)) return;
    rootStarted ??= root.started;
    const parents = new Set([pid]);
    while (true) {
      let added = false;
      for (const [candidate, identity] of current)
        if (!parents.has(candidate) && parents.has(identity.parentPid)) {
          parents.add(candidate);
          owned.set(candidate, identity);
          added = true;
        }
      if (!added) break;
    }
  };
  const record = () => {
    if (pending) return;
    pending = capture().finally(() => {
      pending = null;
    });
    void pending.catch(() => {});
  };
  record();
  const timer = setInterval(record, 100);
  timer.unref();
  return Object.freeze({
    async close(): Promise<readonly number[]> {
      clearInterval(timer);
      await pending;
      const deadline = Date.now() + 1500;
      let active: number[] = [];
      do {
        const current = await processes();
        active = [...owned]
          .filter(
            ([candidate, identity]) =>
              current.get(candidate)?.started === identity.started,
          )
          .map(([candidate]) => candidate);
        if (active.length === 0) return [];
        if (Date.now() < deadline)
          await new Promise((accept) => setTimeout(accept, 20));
      } while (Date.now() < deadline);
      for (const candidate of active) {
        try {
          process.kill(candidate, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      return active;
    },
  });
}
