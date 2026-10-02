import type { PluginJsonValue } from "./sdk-types.js";
import type { PluginToolExecutionCommand } from "./tool-runtime-types.js";

export type PluginExternalOperationStatus =
  | "submitting"
  | "submitted"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "unknownOutcome";

/** Durable evidence for the host-bound Run or its explicitly admitted query source. */
export type PluginExternalOperation = Readonly<{
  schemaVersion: "crewon.external-operation.v0";
  tenantId: string;
  runId: string;
  bindingDigest: string;
  operationId: string;
  executionId: string;
  idempotencyKey: string;
  actionDigest: string;
  requestDigest: string;
  correlationId: string;
  providerOperationId: string | null;
  status: PluginExternalOperationStatus;
  resultJson: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}>;

/** Relative path and finite JSON only; the host supplies the approved service origin. */
export type PluginJsonHttpSubmission = Readonly<{
  method: "POST";
  path: string;
  body: PluginJsonValue;
}>;

/**
 * Commands must be the actual objects passed into the active runtime method.
 * DTO copies, Run metadata and operation IDs do not grant execution authority.
 */
export interface PluginExternalOperationService {
  reserve(
    input: Readonly<{
      command: PluginToolExecutionCommand;
      operationId: string;
      request: PluginJsonHttpSubmission;
    }>,
  ): Promise<
    Readonly<{
      disposition: "created" | "existing";
      operation: PluginExternalOperation;
      /** One use, in this active execution only. Existing evidence never receives one. */
      dispatchRef: string | null;
    }>
  >;
  load(
    input: Readonly<{
      command: PluginToolExecutionCommand;
      operationId: string;
    }>,
  ): Promise<PluginExternalOperation | null>;
  advance(
    input: Readonly<{
      command: PluginToolExecutionCommand;
      operationId: string;
      expectedRevision: number;
      providerOperationId: string | null;
      status: PluginExternalOperationStatus;
      resultJson: string | null;
    }>,
  ): Promise<
    Readonly<{
      disposition: "updated" | "conflict";
      operation: PluginExternalOperation;
    }>
  >;
}

export interface PluginOperationJsonHttpService {
  request(
    input: Readonly<{
      command: PluginToolExecutionCommand;
      operationId: string;
      dispatchRef?: string;
      method: "GET" | "POST";
      path: string;
      body?: PluginJsonValue;
    }>,
  ): Promise<PluginJsonValue>;
}

/** Optional, host-bound IO. Plugins cannot choose an actor, payer, Store or network origin. */
export type PluginExecutionServices = Readonly<{
  approvalRequirement: "none" | "perAction";
  externalOperations?: PluginExternalOperationService;
  jsonHttp?: PluginOperationJsonHttpService;
}>;
