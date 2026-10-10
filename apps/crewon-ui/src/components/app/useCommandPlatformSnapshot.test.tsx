// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentPlatformSnapshot } from "../../lib/agent-platform/agentPlatformClient";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../../lib/agent-platform/agentPlatformSessionEvents";
import type { CommandWorkspacePlatformSnapshotLoader } from "./CommandWorkspaceHostModule";
import { emptyAgentPlatformSnapshot } from "./commandWorkspaceState";
import { useCommandPlatformSnapshot } from "./useCommandPlatformSnapshot";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
let latest: ReturnType<typeof useCommandPlatformSnapshot>;
function Probe({ loader }: { loader: CommandWorkspacePlatformSnapshotLoader }) {
  latest = useCommandPlatformSnapshot(loader);
  return (
    <div>
      {latest.platformState}:{latest.platformSnapshot.agents[0]?.name}
    </div>
  );
}
function controlledLoader() {
  const reads: {
    signal: AbortSignal;
    resolve: (snapshot: AgentPlatformSnapshot) => void;
    reject: (error: Error) => void;
  }[] = [];
  const loader = vi.fn<CommandWorkspacePlatformSnapshotLoader>(
    (options) =>
      new Promise((resolve, reject) => {
        reads.push({ signal: options!.signal!, resolve, reject });
      }),
  );
  return { reads, loader };
}
const snapshot = (name: string): AgentPlatformSnapshot => ({
  ...emptyAgentPlatformSnapshot,
  agents: [{ id: 1, name }],
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("starts one catalog read under StrictMode and aborts real work on exit", async () => {
  const { loader, reads } = controlledLoader();
  await act(async () =>
    root.render(
      <StrictMode>
        <Probe loader={loader} />
      </StrictMode>,
    ),
  );
  expect(loader).toHaveBeenCalledTimes(1);
  expect(reads[0].signal.aborted).toBe(false);
  await act(async () => root.unmount());
  expect(reads[0].signal.aborted).toBe(true);
});

it("cancels superseded refreshes and rejects late data from an old owner", async () => {
  const { loader, reads } = controlledLoader();
  await act(async () => root.render(<Probe loader={loader} />));
  let refresh: Promise<void>;
  await act(async () => {
    refresh = latest.reloadPlatformResources();
  });
  expect(reads[0].signal.aborted).toBe(true);
  await act(async () => {
    reads[1].resolve(snapshot("current"));
    await refresh!;
    reads[0].resolve(snapshot("stale"));
  });
  expect(container.textContent).toBe("ready:current");
});

it("does not publish an abandoned account's catalog into a new loader lifetime", async () => {
  const old = controlledLoader();
  const next = controlledLoader();
  await act(async () => root.render(<Probe loader={old.loader} />));
  await act(async () => root.render(<Probe loader={next.loader} />));
  expect(old.reads[0].signal.aborted).toBe(true);
  await act(async () => {
    next.reads[0].resolve(snapshot("new account"));
    old.reads[0].resolve(snapshot("old account"));
  });
  expect(container.textContent).toBe("ready:new account");
});

it("allows an explicit retry after catalog failure without any account mutation", async () => {
  const { loader, reads } = controlledLoader();
  await act(async () => root.render(<Probe loader={loader} />));
  await act(async () => reads[0].reject(new Error("directory unavailable")));
  expect(latest.platformState).toBe("fallback");
  let refresh: Promise<void>;
  await act(async () => {
    refresh = latest.reloadPlatformResources();
  });
  await act(async () => {
    reads[1].resolve(snapshot("recovered"));
    await refresh!;
  });
  expect(container.textContent).toBe("ready:recovered");
});

it("withdraws old catalog data and rereads on an account or token epoch change", async () => {
  const { loader, reads } = controlledLoader();
  await act(async () => root.render(<Probe loader={loader} />));
  await act(async () => reads[0].resolve(snapshot("old epoch")));
  expect(container.textContent).toBe("ready:old epoch");
  await act(async () =>
    window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT)),
  );
  expect(reads[0].signal.aborted).toBe(true);
  expect(container.textContent).toBe("loading:");
  await act(async () => reads[1].resolve(snapshot("current epoch")));
  expect(container.textContent).toBe("ready:current epoch");
});
