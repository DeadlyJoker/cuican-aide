import type { ChildProcess } from "node:child_process";
import { captureDesktopNativePluginAuthorityOwner } from "./desktopNativePluginAuthority.ts";
import { DesktopNativeProjectWorkspaceBridge } from "./desktopNativeProjectWorkspaceBridge.ts";
import type { LocalWorkspaceAuthority } from "./localWorkspaceRegistry.ts";

const owners = new WeakMap<
  object,
  Readonly<{ nativeAuthority: unknown; assertCurrent(): void }>
>();
/** Trusted Native runtime producer only; no serializable authority or renderer field is added. */
export function bindDesktopNativeProjectWorkspaceRuntime(
  input: Readonly<{
    owner: object;
    nativeAuthority: unknown;
    assertCurrent(): void;
  }>,
): void {
  captureDesktopNativePluginAuthorityOwner(input.nativeAuthority);
  input.assertCurrent();
  if (owners.has(input.owner))
    throw new Error("desktop_native_project_workspace_runtime_duplicate");
  owners.set(
    input.owner,
    Object.freeze({
      nativeAuthority: input.nativeAuthority,
      assertCurrent: input.assertCurrent.bind(input),
    }),
  );
}
export function attachDesktopNativeProjectWorkspaceRuntime(
  input: Readonly<{
    owner: object;
    workspaces: LocalWorkspaceAuthority;
    control: ChildProcess;
    signal: AbortSignal;
  }>,
): DesktopNativeProjectWorkspaceBridge | undefined {
  const source = owners.get(input.owner);
  if (!source) return undefined;
  source.assertCurrent();
  const bridge = new DesktopNativeProjectWorkspaceBridge({
    nativeAuthority: source.nativeAuthority,
    workspaces: input.workspaces,
    control: input.control,
    signal: input.signal,
  });
  try {
    source.assertCurrent();
    return bridge;
  } catch (error) {
    void bridge.close();
    throw error;
  }
}
