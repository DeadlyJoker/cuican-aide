import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
  source: { setEnabled: vi.fn(), verifyScreenshot: vi.fn(() => false) },
  send: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcRenderer: {
    on: (
      channel: string,
      listener: (event: unknown, payload: unknown) => void,
    ) => fixture.listeners.set(channel, listener),
    send: fixture.send,
  },
}));
vi.mock("./recordingSource.ts", () => ({
  installRecordingSource: () => fixture.source,
}));
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.listeners.clear();
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  await import("./recordingPagePreload.ts");
});
afterEach(() => vi.unstubAllGlobals());
const arm = (generation: string | null) =>
  fixture.listeners.get("crewon:recording:arm")!({}, { generation });
it("keeps screenshot invalidation across duplicate arm acknowledgements", () => {
  arm("generation-1");
  fixture.source.setEnabled.mockClear();
  arm("generation-1");
  expect(fixture.source.setEnabled).not.toHaveBeenCalled();
  expect(fixture.send).toHaveBeenLastCalledWith(
    "crewon:recording:armed",
    "generation-1",
  );
  arm("generation-2");
  expect(fixture.source.setEnabled.mock.calls).toEqual([[false], [true]]);
});
it("never verifies a previous generation or a disarmed page", () => {
  arm("generation-1");
  const verify = fixture.listeners.get("crewon:recording:verify-screenshot")!;
  verify(
    {},
    { requestId: "request-1", generation: "previous", selector: "button" },
  );
  expect(fixture.source.verifyScreenshot).not.toHaveBeenCalled();
  verify(
    {},
    { requestId: "request-2", generation: "generation-1", selector: "button" },
  );
  expect(fixture.send).toHaveBeenLastCalledWith(
    "crewon:recording:screenshot-verified",
    { requestId: "request-2", generation: "generation-1", safe: false },
  );
  arm(null);
  fixture.source.verifyScreenshot.mockClear();
  verify(
    {},
    { requestId: "request-3", generation: "generation-1", selector: "button" },
  );
  expect(fixture.source.verifyScreenshot).not.toHaveBeenCalled();
});
