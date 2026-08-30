import type { DeviceGateway } from "./device-gateway.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import type { WorkspaceReadApiDispatchPort } from "./device-gateway-workspace-read-api.ts";
import type { DeviceGatewayWorkspaceReadService } from "./device-gateway-workspace-read-service.ts";

/** Adapts intent-bearing private calls to the local durable authority. */
export function workspaceReadApiDispatch(
  gateway: DeviceGateway,
  service: DeviceGatewayWorkspaceReadService,
): WorkspaceReadApiDispatchPort {
  const requireIntent = (
    deviceId: string,
    intent: { deviceBindingId: string; runtimeBindingId: string },
  ) => {
    const target = gateway.workspaceReadSession(deviceId, intent);
    if (
      target !== null &&
      (target.route.deviceBindingId !== intent.deviceBindingId ||
        target.route.runtimeBindingId !== intent.runtimeBindingId)
    )
      throw new DeviceGatewayError("workspace_read_route_stale");
  };
  return {
    execute(worker, intent, command, signal) {
      requireIntent(command.deviceId, intent);
      return service.execute(worker, intent, command, signal);
    },
    reconcile(worker, intent, reference, signal) {
      requireIntent(reference.deviceId, intent);
      return service.reconcile(worker, intent, reference, signal);
    },
    cancel(worker, intent, reference, signal) {
      requireIntent(reference.deviceId, intent);
      return service.cancel(worker, intent, reference, signal);
    },
  };
}
