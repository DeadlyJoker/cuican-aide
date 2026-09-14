// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAgentPlatformResources } from "./useAgentPlatformResources";
import { emptyAgentPlatformSnapshot } from "./commandWorkspaceState";
import {
  AGENT_PLATFORM_SESSION_CHANGED_EVENT,
  readAgentPlatformSnapshot,
} from "../../lib/agent-platform/agentPlatformClient";
vi.mock("../../lib/agent-platform/agentPlatformClient", async (original) => ({
  ...(await original<object>()),
  readAgentPlatformSnapshot: vi.fn(),
}));
let root: Root;
let node: HTMLDivElement;
function Probe() {
  const value = useAgentPlatformResources();
  return (
    <div>
      {value.platformState}:
      {value.platformSnapshot.agents.map((agent) => agent.name).join(",")}
    </div>
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  node = document.createElement("div");
  root = createRoot(node);
  vi.mocked(readAgentPlatformSnapshot).mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("recovers a first-load network failure without relaunching", async () => {
  vi.mocked(readAgentPlatformSnapshot)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(emptyAgentPlatformSnapshot);
  await act(async () => root.render(<Probe />));
  expect(node.textContent).toBe("fallback:");
  await act(async () => vi.advanceTimersByTimeAsync(35_000));
  expect(node.textContent).toBe("ready:");
  expect(readAgentPlatformSnapshot).toHaveBeenCalledTimes(2);
});
it("bounds automatic retries and allows network recovery to retry again", async () => {
  vi.mocked(readAgentPlatformSnapshot).mockRejectedValue(new Error("offline"));
  await act(async () => root.render(<Probe />));
  await act(async () => vi.advanceTimersByTimeAsync(180_000));
  expect(readAgentPlatformSnapshot).toHaveBeenCalledTimes(4);
  vi.mocked(readAgentPlatformSnapshot).mockResolvedValue(
    emptyAgentPlatformSnapshot,
  );
  await act(async () => globalThis.dispatchEvent(new Event("online")));
  expect(node.textContent).toBe("ready:");
});
it("ignores an old account's in-flight response after the session changes", async () => {
  let resolveOld!: (value: typeof emptyAgentPlatformSnapshot) => void;
  vi.mocked(readAgentPlatformSnapshot)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    )
    .mockResolvedValue(emptyAgentPlatformSnapshot);
  await act(async () => root.render(<Probe />));
  await act(async () =>
    globalThis.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT)),
  );
  await act(async () =>
    resolveOld({
      ...emptyAgentPlatformSnapshot,
      agents: [{ id: 1, name: "old-account" }],
    }),
  );
  expect(node.textContent).toBe("ready:");
});
