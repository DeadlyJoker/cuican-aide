import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Exclusive per-checkout admission; stale ownership is diagnosed, never guessed away. */
export function acquireSoakLease(output: string, root: string) {
  const path = join(output, "active.json");
  const value = JSON.stringify({
    pid: process.pid,
    root,
    createdAt: new Date().toISOString(),
  });
  try {
    writeFileSync(path, value, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`soak_active_or_stale_lease:${path}`);
    throw error;
  }
  return () => {
    if (readFileSync(path, "utf8") !== value)
      throw new Error("soak_lease_changed");
    unlinkSync(path);
  };
}
