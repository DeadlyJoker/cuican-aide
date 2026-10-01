import type { ChildProcess } from "node:child_process";
import { parseDesktopExtensionHostOrigin } from "./desktopExtensionRuntime.ts";

export type DesktopCurrentRuntimeChildren = Readonly<{
  control: ChildProcess;
  worker: ChildProcess;
}>;
export type DesktopHistoricalControlPeer = Readonly<{
  origin: string;
  token: string;
  deadlineMs: number;
}>;

/** Native private peers only; no historical catalog or publication authority. */
export function desktopControlHistoricalEnvironment(input: {
  environment: NodeJS.ProcessEnv;
  peers: readonly DesktopHistoricalControlPeer[];
}): NodeJS.ProcessEnv {
  const environment = { ...input.environment };
  delete environment.CREWON_EXTENSION_HISTORICAL_HOSTS_JSON;
  if (!Array.isArray(input.peers) || input.peers.length > 4)
    throw new Error("desktop_historical_control_peers_invalid");
  const origins = new Set<string>();
  const peers = input.peers.map((peer) => {
    const origin = parseDesktopExtensionHostOrigin(peer.origin);
    if (
      origins.has(origin) ||
      origin === environment.CREWON_EXTENSION_HOST_ORIGIN ||
      !/^[a-f0-9]{64}$/u.test(peer.token) ||
      !Number.isSafeInteger(peer.deadlineMs) ||
      peer.deadlineMs < 1000 ||
      peer.deadlineMs > 30_000
    )
      throw new Error("desktop_historical_control_peers_invalid");
    origins.add(origin);
    return { origin, token: peer.token, deadlineMs: peer.deadlineMs };
  });
  if (peers.length > 0) {
    if (environment.CREWON_EXTENSIONS_ENABLED !== "1")
      throw new Error("desktop_historical_control_peers_invalid");
    environment.CREWON_EXTENSION_HISTORICAL_HOSTS_JSON = JSON.stringify(peers);
  }
  return environment;
}

/** Stop the old Control before replacing it. The current Worker keeps its ownership. */
export async function replaceDesktopControlRuntime(input: {
  current: DesktopCurrentRuntimeChildren;
  environment: NodeJS.ProcessEnv;
  signal: AbortSignal;
  terminateControl: (child: ChildProcess) => Promise<void>;
  spawnControl: (environment: NodeJS.ProcessEnv) => ChildProcess;
  trackChild: (child: ChildProcess) => void;
  onControlSpawned?: (children: DesktopCurrentRuntimeChildren) => void;
  waitForReady: (
    children: readonly ChildProcess[],
    signal: AbortSignal,
  ) => Promise<void>;
}): Promise<DesktopCurrentRuntimeChildren> {
  const environment = { ...input.environment };
  const current = Object.freeze({ ...input.current });
  input.signal.throwIfAborted();
  await input.terminateControl(current.control);
  input.signal.throwIfAborted();
  if (current.control.exitCode === null && current.control.signalCode === null)
    throw new Error("desktop_control_shutdown_incomplete");
  if (current.worker.exitCode !== null || current.worker.signalCode !== null)
    throw new Error("control_runtime_child_exited");
  const control = input.spawnControl(environment);
  input.trackChild(control);
  input.onControlSpawned?.(Object.freeze({ control, worker: current.worker }));
  await input.waitForReady([control, current.worker], input.signal);
  input.signal.throwIfAborted();
  if (
    control.exitCode !== null ||
    control.signalCode !== null ||
    current.worker.exitCode !== null ||
    current.worker.signalCode !== null
  )
    throw new Error("control_runtime_child_exited");
  return Object.freeze({ control, worker: current.worker });
}
