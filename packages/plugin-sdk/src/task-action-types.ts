import type { PluginJsonValue } from "./sdk-types.js";

export const CREWON_TASKS_SERVICE = "crewon.tasks";
export const CREWON_TASKS_API_VERSION = "1";

/** Host-issued, bounded invocation authority; callers never supply an actor, payer or profile. */
export type PluginTaskRequest = Readonly<{
  invocationRef: string;
  threadId: string;
  expectedThreadRevision: number;
  idempotencyKey: string;
  input: PluginJsonValue;
}>;

/** Receipt for the original Turn/Run path; execution and event streams remain host-owned. */
export type PluginTaskReceipt = Readonly<{
  disposition: "committed" | "replayed";
  threadId: string;
  threadRevision: number;
  runId: string;
  messageId: string;
  configurationRevision: number;
}>;

export interface PluginTaskService {
  createTask(input: PluginTaskRequest): Promise<PluginTaskReceipt>;
}

/** Declarations are metadata; the host independently authorizes each current invocation. */
export type PluginActionDeclaration = Readonly<{
  contributionId: string;
  action: string;
  kind: "read" | "generateTask";
}>;

export type PluginActionInvocation = Readonly<{
  invocationRef: string;
  contributionId: string;
  action: string;
  input: PluginJsonValue;
}>;

/** Provided under the package's own pluginId, service API version "1". */
export interface PluginActionsService {
  readonly actions: readonly PluginActionDeclaration[];
  invoke(input: PluginActionInvocation): Promise<PluginJsonValue>;
}
