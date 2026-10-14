// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useControlApiClient } from "./useControlApiClient";
import { loadControlApiClient } from "./controlRuntimeBootstrap";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";

vi.mock("./controlRuntimeBootstrap", () => ({ loadControlApiClient: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const load = vi.mocked(loadControlApiClient);
type Client = NonNullable<Awaited<ReturnType<typeof loadControlApiClient>>>;
const clientA = { name: "original" } as unknown as Client;
const clientB = { name: "reconnected" } as unknown as Client;
let root: Root;
let container: HTMLDivElement;
let observed: Client | null;
let sessionChanged: (() => void) | undefined;
const unsubscribe = vi.fn();
function Probe() {
  observed = useControlApiClient();
  return <div>{observed ? "connected" : "disconnected"}</div>;
}
async function mount() {
  await act(async () => {
    root.render(<Probe />);
  });
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  load.mockReset();
  unsubscribe.mockReset();
  observed = null;
  sessionChanged = undefined;
  Object.defineProperty(window, "crewonDesktop", {
    configurable: true,
    value: {
      version: 1,
      runtime: {
        onLocalManagementAccessChanged: (listener: () => void) => {
          sessionChanged = listener;
          return unsubscribe;
        },
      },
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, "crewonDesktop");
  vi.useRealTimers();
});

describe("desktop Control connection recovery", () => {
  it("adopts the original late verified Web connection without another bootstrap", async () => {
    Reflect.deleteProperty(window, "crewonDesktop");
    let deliver!: (client: Client) => void;
    load.mockImplementation(async (options) => {
      deliver = options!.onLateClient!;
      return null;
    });
    await mount();
    expect(observed).toBeNull();
    await act(async () => deliver(clientA));
    expect(observed).toBe(clientA);
    await advance(60_000);
    expect(load).toHaveBeenCalledOnce();
  });
  it("ignores an old late completion after the host session generation changes", async () => {
    Reflect.deleteProperty(window, "crewonDesktop");
    let original!: (client: Client) => void;
    load.mockImplementationOnce(async (options) => {
      original = options!.onLateClient!;
      return null;
    });
    load.mockResolvedValueOnce(clientB);
    await mount();
    await act(async () => {
      window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT));
    });
    await act(async () => original(clientA));
    expect(load).toHaveBeenCalledTimes(2);
    expect(observed).toBe(clientB);
  });
  it("recovers after a transient bootstrap failure and stops polling once connected", async () => {
    load.mockResolvedValueOnce(null).mockResolvedValue(clientA);
    await mount();
    expect(container.textContent).toBe("disconnected");
    await advance(1_000);
    expect(observed).toBe(clientA);
    expect(container.textContent).toBe("connected");
    await advance(60_000);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("bounds failed retries and allows a later foreground retry", async () => {
    load.mockResolvedValue(null);
    await mount();
    await advance(120_000);
    expect(load).toHaveBeenCalledTimes(6);
    load.mockResolvedValue(clientA);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(observed).toBe(clientA);
    expect(load).toHaveBeenCalledTimes(7);
  });
  it("ignores a stale bootstrap after native session invalidation", async () => {
    let finishOld!: (client: Client) => void;
    load
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishOld = resolve;
        }),
      )
      .mockResolvedValue(clientB);
    await mount();
    await act(async () => {
      sessionChanged!();
    });
    expect(observed).toBe(clientB);
    await act(async () => {
      finishOld(clientA);
    });
    expect(observed).toBe(clientB);
    await advance(60_000);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("cancels retries and subscriptions on unmount", async () => {
    load.mockResolvedValue(null);
    await mount();
    await act(async () => {
      root.render(null);
    });
    await advance(60_000);
    expect(load).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("preserves Web behavior without desktop retry timers", async () => {
    Reflect.deleteProperty(window, "crewonDesktop");
    load.mockResolvedValue(null);
    await mount();
    await advance(120_000);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(load).toHaveBeenCalledOnce();
  });
});
