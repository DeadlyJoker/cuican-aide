import { ContractValidationError } from "./contract-validation-error.ts";
import { parseDeviceWorkspaceListCommand } from "./device-protocol-workspace.ts";
import {
  DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
  DEVICE_WORKSPACE_LIST_DISPATCH_MAX_ERROR_BYTES,
  DEVICE_WORKSPACE_LIST_DISPATCH_MAX_REQUEST_BYTES,
  DEVICE_WORKSPACE_LIST_DISPATCH_MAX_RESPONSE_BYTES,
  type DeviceWorkspaceListDispatchError,
  type DeviceWorkspaceListDispatchReference,
  type DeviceWorkspaceListPeerDispatchRequest,
  type DeviceWorkspaceListPeerDispatchResponse,
  type DeviceWorkspaceListWorkerDispatchRequest,
  type DeviceWorkspaceListWorkerDispatchResponse,
} from "./device-workspace-list-dispatch-types.ts";
import {
  parseOperation,
  parsePeerRoute,
  parsePeerSourceWorker,
  parseResolution,
  requireBoundedJson,
  requireExactKeys,
  requireObject,
  requireOpaqueId,
  requireDigest,
  requireSafeCode,
  samePeerRoute,
} from "./device-workspace-list-dispatch-support.ts";

export function parseDeviceWorkspaceListDispatchReference(
  input: unknown,
): DeviceWorkspaceListDispatchReference {
  const reference = requireObject(
    input,
    "device_workspace_dispatch_reference_invalid",
  );
  requireExactKeys(reference, [
    "actionDigest",
    "commandDigest",
    "deviceBindingId",
    "deviceId",
    "executionId",
    "incarnationId",
    "receiptId",
    "runtimeBindingId",
    "workspaceBindingId",
  ]);
  return {
    deviceId: requireOpaqueId(reference.deviceId, "device_id_invalid"),
    executionId: requireOpaqueId(
      reference.executionId,
      "device_execution_id_invalid",
    ),
    workspaceBindingId: requireOpaqueId(
      reference.workspaceBindingId,
      "device_workspace_binding_invalid",
    ),
    incarnationId: requireOpaqueId(
      reference.incarnationId,
      "device_workspace_incarnation_invalid",
    ),
    deviceBindingId: requireOpaqueId(
      reference.deviceBindingId,
      "device_binding_id_invalid",
    ),
    runtimeBindingId: requireOpaqueId(
      reference.runtimeBindingId,
      "device_runtime_binding_id_invalid",
    ),
    actionDigest: requireDigest(
      reference.actionDigest,
      "device_action_digest_invalid",
    ),
    commandDigest: requireDigest(
      reference.commandDigest,
      "device_command_digest_invalid",
    ),
    receiptId:
      reference.receiptId === null
        ? null
        : requireOpaqueId(reference.receiptId, "device_receipt_id_invalid"),
  };
}
