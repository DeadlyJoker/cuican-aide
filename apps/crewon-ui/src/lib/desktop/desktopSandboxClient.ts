import type { SandboxCapabilityClient } from "../control-runtime/useControlSandboxCapabilities";
import { hasDesktopBridge } from "../platform";
import { requireDesktopBridge } from "./desktopBridge";

type NativeDirectoryView = Awaited<
  ReturnType<SandboxCapabilityClient["listSandboxDirectory"]>
>;
type NativeFileView = Awaited<
  ReturnType<SandboxCapabilityClient["readSandboxFile"]>
>;
type NativeDiffView = Awaited<
  ReturnType<SandboxCapabilityClient["readSandboxDiff"]>
>;
type NativeCommandView = Awaited<
  ReturnType<SandboxCapabilityClient["runSandboxCommand"]>
>;

export type DesktopSandboxInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export function createDesktopSandboxClient(
  invokeDesktop: DesktopSandboxInvoke,
): SandboxCapabilityClient {
  return {
    listSandboxDirectory: (_threadId, path) =>
      invokeNative<NativeDirectoryView>(
        invokeDesktop,
        "desktop_sandbox_list_directory",
        { path },
      ),
    readSandboxFile: (_threadId, path) =>
      invokeNative<NativeFileView>(invokeDesktop, "desktop_sandbox_read_file", {
        path,
      }),
    readSandboxDiff: () =>
      invokeNative<NativeDiffView>(invokeDesktop, "desktop_sandbox_read_diff"),
    runSandboxCommand: (_threadId, request) =>
      invokeNative<NativeCommandView>(
        invokeDesktop,
        "desktop_sandbox_run_command",
        { request },
      ),
  };
}

const desktopSandbox = createDesktopSandboxClient(async (command, args) => {
  const bridge = requireDesktopBridge().sandbox;
  switch (command) {
    case "desktop_sandbox_list_directory":
      return bridge.listDirectory(args?.path as string | undefined);
    case "desktop_sandbox_read_file":
      return bridge.readFile(args?.path as string);
    case "desktop_sandbox_read_diff":
      return bridge.readDiff();
    case "desktop_sandbox_run_command":
      return bridge.runCommand(args?.request);
    default:
      throw new Error("desktop_sandbox_command_unknown");
  }
});

/** Uses the selected OS workspace only on the real desktop surface. */
export function desktopSandboxClient(): SandboxCapabilityClient | null {
  return hasDesktopBridge() ? desktopSandbox : null;
}

async function invokeNative<T>(
  invokeDesktop: DesktopSandboxInvoke,
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return (await (args === undefined
      ? invokeDesktop(command)
      : invokeDesktop(command, args))) as T;
  } catch (error) {
    throw new Error(
      typeof error === "string" ? error : "desktop_sandbox_unavailable",
    );
  }
}
