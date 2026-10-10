// @vitest-environment happy-dom
import type { ControlApiClient } from "@crewon/control-client";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type {
  DesktopWorkspaceAuthorityPort,
  DesktopWorkspaceStatus,
} from "../desktop/desktopWorkspaceAuthorityAdapter";
import { useControlWorkspaceRuntime } from "./useControlWorkspaceRuntime";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const client = {} as ControlApiClient;
const workspaces = [
  { workspaceId: "workspace-a", displayName: "Project A" },
  { workspaceId: "workspace-b", displayName: "Project B" },
] as const;

function nativeAuthority(snapshot = workspaceStatus()) {
  return {
    status: vi.fn(async () => snapshot),
    selectAndRegister: vi.fn(async () => ({
      outcome: "committed" as const,
      snapshot,
    })),
    activate: vi.fn(async () => ({ outcome: "committed" as const, snapshot })),
    clear: vi.fn(async () => ({ outcome: "committed" as const, snapshot })),
  } satisfies DesktopWorkspaceAuthorityPort;
}

function workspaceStatus(
  overrides: Partial<DesktopWorkspaceStatus> = {},
): DesktopWorkspaceStatus {
  return {
    schemaVersion: "crewon.desktop-workspace-status.v0",
    availability: "available",
    revision: 4,
    supervisorGeneration: 7,
    current: workspaces[0],
    workspaces,
    ...overrides,
  };
}

describe("Workspace hook authority lifecycle", () => {
  it("keeps the native roster and folder actions live after StrictMode effect replay", async () => {
    const native = nativeAuthority();
    let observed!: ReturnType<typeof useControlWorkspaceRuntime>;
    function Probe() {
      observed = useControlWorkspaceRuntime({
        client,
        nativeAuthority: native,
        selectedThreadId: null,
      });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <Probe />
          </StrictMode>,
        );
      });
      expect(observed.mutationAuthority).toBe("desktop");
      expect(observed.nativeWorkspaces).toEqual(workspaces);
      expect(observed.nativeWorkspace?.workspaceId).toBe("workspace-a");
      await act(async () => {
        expect(await observed.selectNativeWorkspace()).toBe(true);
      });
      expect(native.selectAndRegister).toHaveBeenCalledExactlyOnceWith({
        expectedRevision: 4,
        idempotencyKey: expect.any(String),
      });
      expect(observed.nativeWorkspaces).toEqual(workspaces);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("does not restore stale native authority after switching to a Web-only connection", async () => {
    let resolveNative!: (value: DesktopWorkspaceStatus) => void;
    const native = nativeAuthority();
    native.status.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveNative = resolve;
        }),
    );
    let observed!: ReturnType<typeof useControlWorkspaceRuntime>;
    function Probe({
      authority,
    }: {
      authority: DesktopWorkspaceAuthorityPort | null;
    }) {
      observed = useControlWorkspaceRuntime({
        client,
        nativeAuthority: authority,
        selectedThreadId: null,
      });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(<Probe authority={native} />));
      expect(observed.mutationAuthority).toBe("unavailable");
      await act(async () => root.render(<Probe authority={null} />));
      await act(async () => resolveNative(workspaceStatus()));
      expect(observed.mutationAuthority).toBe("readOnly");
      expect(observed.nativeWorkspace).toBeNull();
      expect(observed.nativeWorkspaces).toEqual([]);
      await expect(observed.selectNativeWorkspace()).rejects.toThrow(
        "control_workspace_native_authority_unavailable",
      );
      expect(native.selectAndRegister).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
