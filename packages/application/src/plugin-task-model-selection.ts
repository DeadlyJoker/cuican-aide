import {
  extensionCanonicalJson,
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  parsePluginTaskAdmissionPin,
  validateCreativeProjectActor,
  type ExtensionConfiguration,
  type ExtensionExecutionTarget,
  type ExtensionRunBinding,
  type PluginTaskAdmission,
  type PluginTaskAdmissionPin,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import { uiRecord } from "./plugin-ui-application-support.ts";

export type PluginTaskModelSelectionCandidate = Readonly<{
  modelId: string;
  target: ExtensionExecutionTarget;
  assertCurrent(): Promise<void>;
  assertActive(): void;
}>;
/** Installed host only. Public task bodies never supply a target or this port. */
export interface PluginTaskModelSelectionPort {
  prepareModel(
    input: Readonly<{
      actor: ActorContext;
      pin: PluginTaskAdmissionPin;
      configuration: ExtensionConfiguration;
      modelId: string;
    }>,
  ): Promise<PluginTaskModelSelectionCandidate>;
}
export type PreparedPluginTaskModelSelection = Readonly<{
  actor: ActorContext;
  pin: PluginTaskAdmissionPin;
  configurationRevision: number;
  configurationDigest: string;
  modelId: string;
  target: ExtensionExecutionTarget;
  assertCurrent(): Promise<void>;
  assertActive(): void;
}>;
const issued = new WeakSet<object>();

export function pluginTaskModelId(input: unknown): string {
  if (
    typeof input !== "string" ||
    !input ||
    input.trim() !== input ||
    new TextEncoder().encode(input).length > 256 ||
    /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(input)
  )
    denied();
  return input;
}
export async function preparePluginTaskModelSelection(
  port: PluginTaskModelSelectionPort | undefined,
  provided: Parameters<PluginTaskModelSelectionPort["prepareModel"]>[0],
  digester: ContentDigester,
): Promise<PreparedPluginTaskModelSelection> {
  if (port === undefined) unavailable();
  const method = Object.getOwnPropertyDescriptor(port, "prepareModel");
  if (
    !method?.enumerable ||
    !("value" in method) ||
    typeof method.value !== "function"
  )
    denied();
  const input = uiRecord(provided, [
    "actor",
    "pin",
    "configuration",
    "modelId",
  ]);
  const actor = validateCreativeProjectActor(input.actor),
    pin = parsePluginTaskAdmissionPin(input.pin),
    configuration = parseExtensionConfiguration(input.configuration, digester),
    modelId = pluginTaskModelId(input.modelId);
  if (
    pin.action !== "project.execute" ||
    pin.contributionId !== "workbench" ||
    ["tenantId", "spaceId", "principalId", "actorId"].some(
      (k) => actor[k as keyof ActorContext] !== pin[k as keyof typeof pin],
    ) ||
    configuration.tenantId !== actor.tenantId ||
    configuration.spaceId !== actor.spaceId ||
    configuration.pluginId !== pin.pluginId ||
    configuration.pluginVersion !== pin.version
  )
    denied();
  const raw = await method.value.call(
    port,
    Object.freeze({ actor, pin, configuration, modelId }),
  );
  const candidate = uiRecord(raw, [
    "modelId",
    "target",
    "assertCurrent",
    "assertActive",
  ]);
  if (
    candidate.modelId !== modelId ||
    typeof candidate.assertCurrent !== "function" ||
    typeof candidate.assertActive !== "function"
  )
    denied();
  const target = parseExtensionExecutionTarget(candidate.target);
  const current = candidate.assertCurrent,
    active = candidate.assertActive;
  const result = Object.freeze({
    actor,
    pin,
    configurationRevision: configuration.revision,
    configurationDigest: configuration.contentDigest,
    modelId,
    target,
    assertCurrent: async () => {
      if ((await current.call(raw)) !== undefined) denied();
    },
    assertActive: () => {
      if (active.call(raw) !== undefined) denied();
    },
  });
  await result.assertCurrent();
  result.assertActive();
  issued.add(result);
  return result;
}

/** Same original admission transaction; copied, serialized or caller-created grants are rejected. */
export function assertPluginTaskModelSelectionAdmission(
  provided: PreparedPluginTaskModelSelection,
  binding: ExtensionRunBinding,
  admission?: PluginTaskAdmission,
): void {
  if (
    provided === null ||
    typeof provided !== "object" ||
    !issued.has(provided) ||
    binding.source !== null ||
    binding.actorId !== provided.actor.actorId ||
    binding.tenantId !== provided.actor.tenantId ||
    binding.spaceId !== provided.actor.spaceId ||
    binding.pluginId !== provided.pin.pluginId ||
    binding.configurationRevision !== provided.configurationRevision ||
    binding.configurationDigest !== provided.configurationDigest ||
    extensionCanonicalJson(binding.target) !==
      extensionCanonicalJson(provided.target)
  )
    denied();
  if (
    admission !== undefined &&
    (admission.runId !== binding.runId ||
      Object.keys(provided.pin).some(
        (key) =>
          admission[key as keyof PluginTaskAdmission] !==
          provided.pin[key as keyof PluginTaskAdmissionPin],
      ))
  )
    denied();
  provided.assertActive();
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_task_model_selection_invalid",
  );
}
function unavailable(): never {
  throw new ApplicationError(
    "conflict",
    "plugin_task_model_selection_unavailable",
  );
}
