import type {
  DeviceFilesystemReadCommand,
  DeviceFilesystemReadEvent,
} from "./device-filesystem-read.ts";

export const DEVICE_FILESYSTEM_READ_DISPATCH_API_VERSION = 1 as const;
export const DEVICE_GATEWAY_WORKER_FILESYSTEM_READ_DISPATCH_PATH =
  "/worker/v1/device-filesystem-read-dispatch" as const;
export const DEVICE_GATEWAY_PEER_FILESYSTEM_READ_DISPATCH_PATH =
  "/gateway/v1/device-filesystem-read-dispatch" as const;
export const DEVICE_FILESYSTEM_READ_DISPATCH_MAX_REQUEST_BYTES = 128 * 1024;
export const DEVICE_FILESYSTEM_READ_DISPATCH_MAX_RESPONSE_BYTES = 96 * 1024;
export const DEVICE_FILESYSTEM_READ_DISPATCH_MAX_ERROR_BYTES = 16 * 1024;

export type DeviceFilesystemReadDispatchOperation =
  | "execute"
  | "reconcile"
  | "cancel";
export type DeviceFilesystemReadRouteIntent = Readonly<{
  deviceBindingId: string;
  runtimeBindingId: string;
}>;
export type DeviceFilesystemReadDispatchReference = Readonly<{
  deviceId: string;
  executionId: string;
  workspaceBindingId: string;
  incarnationId: string;
  deviceBindingId: string;
  runtimeBindingId: string;
  actionDigest: string;
  commandDigest: string;
  leaseId: string;
  leaseEpoch: number;
  receiptId: string | null;
}>;
type TerminalResolution<
  S extends string,
  E extends DeviceFilesystemReadEvent["type"],
> = Readonly<{
  status: S;
  executionId: string;
  receiptId: string;
  terminal: Extract<DeviceFilesystemReadEvent, { type: E }>;
}>;
export type DeviceFilesystemReadDispatchResolution =
  | TerminalResolution<"completed", "workspace_read.completed">
  | TerminalResolution<"failed", "workspace_read.failed">
  | TerminalResolution<"canceled", "workspace_read.canceled">
  | Readonly<{
      status: "unknownOutcome";
      executionId: string;
      receiptId: string | null;
      terminal: Extract<
        DeviceFilesystemReadEvent,
        { type: "workspace_read.unknown_outcome" }
      > | null;
    }>;
type WorkerEnvelope = Readonly<{
  schemaVersion: "crewon.device-filesystem-read-dispatch-request.v0";
  apiVersion: 1;
  routeIntent: DeviceFilesystemReadRouteIntent;
}>;
export type DeviceFilesystemReadWorkerDispatchRequest =
  | (WorkerEnvelope & {
      operation: "execute";
      command: DeviceFilesystemReadCommand;
    })
  | (WorkerEnvelope & {
      operation: "reconcile" | "cancel";
      reference: DeviceFilesystemReadDispatchReference;
    });
export type DeviceFilesystemReadPeerRoute = Readonly<{
  deviceId: string;
  gatewayId: string;
  connectionId: string;
  connectionEpoch: number;
  deviceBindingId: string;
  runtimeBindingId: string;
  capability: "workspace.read_file.v0";
  leaseExpiresAt: string;
}>;
export type DeviceFilesystemReadPeerSourceWorker = Readonly<{
  workerId: string;
  credentialId: string;
}>;
type PeerEnvelope = Readonly<{
  schemaVersion: "crewon.device-filesystem-read-peer-dispatch-request.v0";
  apiVersion: 1;
  sourceGatewayId: string;
  sourceWorker: DeviceFilesystemReadPeerSourceWorker;
  route: DeviceFilesystemReadPeerRoute;
}>;
export type DeviceFilesystemReadPeerDispatchRequest =
  | (PeerEnvelope & {
      operation: "execute";
      command: DeviceFilesystemReadCommand;
    })
  | (PeerEnvelope & {
      operation: "reconcile" | "cancel";
      reference: DeviceFilesystemReadDispatchReference;
    });
export type DeviceFilesystemReadWorkerDispatchResponse = Readonly<{
  schemaVersion: "crewon.device-filesystem-read-dispatch-response.v0";
  apiVersion: 1;
  operation: DeviceFilesystemReadDispatchOperation;
  resolution: DeviceFilesystemReadDispatchResolution;
}>;
export type DeviceFilesystemReadPeerDispatchResponse = Readonly<{
  schemaVersion: "crewon.device-filesystem-read-peer-dispatch-response.v0";
  apiVersion: 1;
  operation: DeviceFilesystemReadDispatchOperation;
  route: DeviceFilesystemReadPeerRoute;
  resolution: DeviceFilesystemReadDispatchResolution;
}>;
export type DeviceFilesystemReadDispatchError = Readonly<{
  schemaVersion: "crewon.device-filesystem-read-dispatch-error.v0";
  apiVersion: 1;
  code: string;
  retryable: boolean;
  certainty: "notSent" | "possiblySent";
}>;
