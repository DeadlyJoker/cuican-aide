import type { DesktopPluginBootstrap } from "./desktopPluginBootstrap.ts";
import type { DesktopPluginBootstrapOwner } from "./desktopPluginManagementRuntime.ts";

type Preparation =
  | { state: "prepared"; bootstrap: DesktopPluginBootstrap | null }
  | { state: "quarantined"; bootstrap: null };

/** Native already owns base identity. Invalid plugin inputs cannot issue authority. */
export async function prepareOptionalDesktopPluginBootstrap(
  owner: Pick<DesktopPluginBootstrapOwner, "prepared" | "close">,
  signal: AbortSignal,
): Promise<Preparation> {
  let bootstrap: DesktopPluginBootstrap | null;
  try {
    bootstrap = await owner.prepared();
  } catch {
    // Join cleanup before allowing the base service to start. Cleanup failure and
    // cancellation remain fatal; neither is evidence that authority was withdrawn.
    await owner.close();
    signal.throwIfAborted();
    return { state: "quarantined", bootstrap: null };
  }
  signal.throwIfAborted();
  return { state: "prepared", bootstrap };
}
