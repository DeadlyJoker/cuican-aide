import { createHash } from "node:crypto";
import type {
  PluginToolDefinition,
  PluginToolExecutionCommand,
  PluginToolExecutionPolicy,
  PluginToolRuntimeContext,
} from "@crewon/plugin-sdk/node";
import { captureImageExecutionProfile } from "./image-execution-profile.js";

export const SUBMIT = "crewon_short_drama__submit";
export const OBSERVE = "crewon_short_drama__observe";
export const definitions: readonly PluginToolDefinition[] = [
  {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: SUBMIT,
    description:
      "Generate one image from a text prompt. Submit once, save operationId, then use observe. A submitted status is not a finished image. Never resubmit an uncertain request.",
    execution: "serial",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string", maxLength: 2000 } },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: OBSERVE,
    description:
      "Read a previously submitted image operation in this Run, or the original operation explicitly attached by the host to a query Run. Returns its actual status and image URLs only when generation succeeded. Never invent an operationId or treat unknownOutcome as failure to submit.",
    execution: "serial",
    inputSchema: {
      type: "object",
      properties: { operationId: { type: "string", maxLength: 36 } },
      required: ["operationId"],
      additionalProperties: false,
    },
  },
];

export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
}
export function sha256(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}
export function operationId(
  context: PluginToolRuntimeContext,
  idempotencyKey: string,
): string {
  const raw = sha256(
    JSON.stringify([
      context.scope.tenantId,
      context.run.runId,
      context.run.bindingDigest,
      idempotencyKey,
    ]),
  ).slice(7, 39);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

export function toolPolicy(
  context: PluginToolRuntimeContext,
  approval: "none" | "perAction",
  kind: string,
  name: string,
): PluginToolExecutionPolicy | null {
  if (kind !== "function" || (name !== SUBMIT && name !== OBSERVE)) return null;
  const bindingId =
    "extension:" +
    sha256(
      canonical({
        configurationDigest: context.configuration.contentDigest,
        target: context.target,
      }),
    ).slice(7);
  const submit = name === SUBMIT;
  return {
    effect: submit ? "mutation" : "readOnly",
    recovery: submit ? "reconcilable" : "replaySafe",
    resourceBindingId: bindingId,
    credentialBindingId: null,
    executionTarget: { kind: "control", bindingId },
    capability: submit ? "extension.image.generate" : "extension.image.read",
    approvalRequirement: submit ? approval : "none",
    limits: {
      timeoutMs: 30000,
      maxOutputBytes: 16384,
      maxArtifactBytes: 16384,
    },
  };
}

export function toolInput(
  command: PluginToolExecutionCommand,
  context: PluginToolRuntimeContext,
  approval: "none" | "perAction",
): string {
  const policy = toolPolicy(context, approval, command.kind, command.name);
  const intent = command.actionIntent;
  if (
    !policy ||
    command.runId !== context.run.runId ||
    intent.runId !== command.runId ||
    intent.callId !== command.callId ||
    intent.segmentId !== command.segmentId ||
    intent.tool.kind !== command.kind ||
    intent.tool.name !== command.name ||
    intent.tool.inputDigest !== sha256(command.input) ||
    intent.policySnapshotId !== context.target.policySnapshotId ||
    intent.workspaceBindingId !== context.target.workspaceBindingId ||
    Object.entries(policy).some(
      ([key, value]) =>
        canonical(value) !== canonical(intent[key as keyof typeof intent]),
    )
  )
    throw new Error("krea_plugin_command_mismatch");
  if (context.run.source && command.name === SUBMIT)
    throw new Error("krea_plugin_query_submission_forbidden");
  if (Buffer.byteLength(command.input) > 65536)
    throw new Error("krea_plugin_input_limit");
  const input: unknown = JSON.parse(command.input);
  const key = command.name === SUBMIT ? "prompt" : "operationId";
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !Object.hasOwn(input, key)
  )
    throw new Error("krea_plugin_input_invalid");
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "string") throw new Error("krea_plugin_input_invalid");
  if (key === "prompt")
    captureImageExecutionProfile(context.configuration).submission(
      value,
      "00000000-0000-0000-0000-000000000000",
    );
  else promptId(value);
  return value;
}

export function promptId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      value,
    )
  )
    throw new Error("krea_plugin_prompt_id_invalid");
  return value;
}
