import type { DeviceWorkspaceListCommand } from "./device-protocol-workspace.ts";
import type { DeviceWorkspaceListEvent } from "./device-protocol-workspace-event.ts";

export const DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION = 1 as const;
export const DEVICE_GATEWAY_WORKER_WORKSPACE_LIST_DISPATCH_PATH =
  "/worker/v1/device-workspace-list-dispatch" as const;
export const DEVICE_GATEWAY_PEER_WORKSPACE_LIST_DISPATCH_PATH =
  "/gateway/v1/device-workspace-list-dispatch" as const;

export const DEVICE_WORKSPACE_LIST_DISPATCH_OPERATIONS = [
  "execute",
  "reconcile",
  "cancel",
] as const;

export type DeviceWorkspaceListDispatchOperation =
  (typeof DEVICE_WORKSPACE_LIST_DISPATCH_OPERATIONS)[number];

export type DeviceWorkspaceListDispatchReference = Readonly<{
  deviceId: string;
  executionId: string;
  workspaceBindingId: string;
  incarnationId: string;
  deviceBindingId: string;
  runtimeBindingId: string;
  actionDigest: string;
  commandDigest: string;
  receiptId: string | null;
}>;

export type DeviceWorkspaceListDispatchResolution =
  | Readonly<{
      status: "completed";
      executionId: string;
      receiptId: string;
      terminal: Extract<
        DeviceWorkspaceListEvent,
        { type: "workspace_list.completed" }
      >;
    }>
  | Readonly<{
      status: "failed";
      executionId: string;
      receiptId: string;
      terminal: Extract<
        DeviceWorkspaceListEvent,
        { type: "workspace_list.failed" }
      >;
    }>
  | Readonly<{
      status: "canceled";
      executionId: string;
      receiptId: string;
      terminal: Extract<
        DeviceWorkspaceListEvent,
        { type: "workspace_list.canceled" }
      >;
    }>
  | Readonly<{
      status: "unknownOutcome";
      executionId: string;
      receiptId: string | null;
      terminal: Extract<
        DeviceWorkspaceListEvent,
        { type: "workspace_list.unknown_outcome" }
      > | null;
    }>;

type DeviceWorkspaceListWorkerDispatchRequestEnvelope = Readonly<{
  schemaVersion: "crewon.device-workspace-list-dispatch-request.v0";
  apiVersion: typeof DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION;
}>;

export type DeviceWorkspaceListWorkerDispatchRequest =
  | (DeviceWorkspaceListWorkerDispatchRequestEnvelope &
      Readonly<{
        operation: "execute";
        command: DeviceWorkspaceListCommand;
      }>)
  | (DeviceWorkspaceListWorkerDispatchRequestEnvelope &
      Readonly<{
        operation: "reconcile";
        reference: DeviceWorkspaceListDispatchReference;
      }>)
  | (DeviceWorkspaceListWorkerDispatchRequestEnvelope &
      Readonly<{
        operation: "cancel";
        reference: DeviceWorkspaceListDispatchReference;
      }>);

export type DeviceWorkspaceListWorkerDispatchResponse = Readonly<{
  schemaVersion: "crewon.device-workspace-list-dispatch-response.v0";
  apiVersion: typeof DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION;
  operation: DeviceWorkspaceListDispatchOperation;
  resolution: DeviceWorkspaceListDispatchResolution;
}>;

export type DeviceWorkspaceListPeerRoute = Readonly<{
  deviceId: string;
  gatewayId: string;
  connectionId: string;
  connectionEpoch: number;
  leaseExpiresAt: string;
}>;

export type DeviceWorkspaceListPeerSourceWorker = Readonly<{
  workerId: string;
  credentialId: string;
}>;

type DeviceWorkspaceListPeerDispatchRequestEnvelope = Readonly<{
  schemaVersion: "crewon.device-workspace-list-peer-dispatch-request.v0";
  apiVersion: typeof DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION;
  sourceGatewayId: string;
  sourceWorker: DeviceWorkspaceListPeerSourceWorker;
  route: DeviceWorkspaceListPeerRoute;
}>;

export type DeviceWorkspaceListPeerDispatchRequest =
  | (DeviceWorkspaceListPeerDispatchRequestEnvelope &
      Readonly<{
        operation: "execute";
        command: DeviceWorkspaceListCommand;
      }>)
  | (DeviceWorkspaceListPeerDispatchRequestEnvelope &
      Readonly<{
        operation: "reconcile";
        reference: DeviceWorkspaceListDispatchReference;
      }>)
  | (DeviceWorkspaceListPeerDispatchRequestEnvelope &
      Readonly<{
        operation: "cancel";
        reference: DeviceWorkspaceListDispatchReference;
      }>);

export type DeviceWorkspaceListPeerDispatchResponse = Readonly<{
  schemaVersion: "crewon.device-workspace-list-peer-dispatch-response.v0";
  apiVersion: typeof DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION;
  route: DeviceWorkspaceListPeerRoute;
  operation: DeviceWorkspaceListDispatchOperation;
  resolution: DeviceWorkspaceListDispatchResolution;
}>;

export type DeviceWorkspaceListDispatchError = Readonly<{
  schemaVersion: "crewon.device-workspace-list-dispatch-error.v0";
  apiVersion: typeof DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION;
  code: string;
  retryable: boolean;
  certainty: "notSent" | "possiblySent";
}>;

export const DEVICE_WORKSPACE_LIST_DISPATCH_MAX_REQUEST_BYTES = 160 * 1024;
export const DEVICE_WORKSPACE_LIST_DISPATCH_MAX_RESPONSE_BYTES = 128 * 1024;
export const DEVICE_WORKSPACE_LIST_DISPATCH_MAX_ERROR_BYTES = 16 * 1024;
