import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(uiRoot, "../..");
const uiPort = Number(process.env.CREWON_UI_PORT?.trim() || "5175");
if (!Number.isSafeInteger(uiPort) || uiPort < 1 || uiPort > 65_535) {
  throw new Error("CREWON_UI_PORT_invalid");
}
const uiUrl = `http://127.0.0.1:${uiPort}`;
const children: ChildProcess[] = [];

if (!(await reachable(uiUrl))) {
  const vite = spawn(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    [
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(uiPort),
      "--strictPort",
    ],
    { cwd: uiRoot, env: process.env, stdio: "inherit", windowsHide: true },
  );
  children.push(vite);
  await waitForVite(uiUrl, vite);
}

const electronBinary = createRequire(import.meta.url)("electron") as string;
const electron = spawn(electronBinary, ["."], {
  cwd: uiRoot,
  env: {
    ...process.env,
    CREWON_REPOSITORY_ROOT: repositoryRoot,
    CREWON_UI_DEV_URL: uiUrl,
    CREWON_DESKTOP_WORKSPACE_ROOT:
      process.env.CREWON_DESKTOP_WORKSPACE_ROOT?.trim() || repositoryRoot,
  },
  stdio: "inherit",
  windowsHide: true,
});
children.push(electron);

const shutdown = () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
  }
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
const { code, signal } = await waitForExit(electron);
shutdown();
if (code !== 0 && signal === null) process.exitCode = code ?? 1;

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForVite(url: string, process: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null || process.signalCode !== null) {
      throw new Error("CrewON Vite server exited before becoming ready");
    }
    if (await reachable(url)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("CrewON Vite server readiness timeout");
}

function waitForExit(process: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  if (process.exitCode !== null || process.signalCode !== null) {
    return Promise.resolve({
      code: process.exitCode,
      signal: process.signalCode,
    });
  }
  return new Promise((resolveExit) => {
    process.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}
