import { createHash } from "node:crypto";
import type { ExtensionRegistration } from "@crewon/application";
import {
  extensionCanonicalJson,
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  parseExtensionManifest,
  validateExtensionConfiguration,
  type ExtensionConfiguration,
  type ExtensionExecutionTarget,
} from "@crewon/domain";
import type { ToolExecutionPolicy, ToolRuntimePort } from "@crewon/tool-broker";

export type RuntimeExtensionMaterialization = Readonly<{
  configuration: ExtensionConfiguration;
  registration: ExtensionRegistration;
  target: ExtensionExecutionTarget;
  approvalRequirement: ToolExecutionPolicy["approvalRequirement"];
}>;
const materializations = new WeakMap<
  ToolRuntimePort,
  readonly RuntimeExtensionMaterialization[]
>();
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

/** Called only after the host successfully constructs the actual final tool owner. */
export function registerRuntimeExtensionMaterializations(
  runtime: ToolRuntimePort,
  input: readonly RuntimeExtensionMaterialization[],
): void {
  if (!Array.isArray(input) || input.length < 1 || input.length > 32)
    throw invalid();
  const checked = Object.freeze(
    input.map(parseRuntimeExtensionMaterialization),
  );
  const identities = checked.map((proof) => proof.configuration.pluginId);
  if (new Set(identities).size !== identities.length) throw invalid();
  const existing = materializations.get(runtime);
  if (existing !== undefined) {
    if (JSON.stringify(existing) !== JSON.stringify(checked)) throw invalid();
    return;
  }
  materializations.set(runtime, checked);
}

/** Unregistered tool catalogs never prove executable plugin installation. */
export function readRuntimeExtensionMaterializations(
  runtime: ToolRuntimePort,
): readonly RuntimeExtensionMaterialization[] | null {
  return materializations.get(runtime) ?? null;
}

export function parseRuntimeExtensionMaterialization(
  input: RuntimeExtensionMaterialization,
): RuntimeExtensionMaterialization {
  try {
    if (
      Object.keys(input).sort().join() !==
        "approvalRequirement,configuration,registration,target" ||
      (input.approvalRequirement !== "none" &&
        input.approvalRequirement !== "perAction")
    )
      throw invalid();
    const configuration = parseExtensionConfiguration(
      input.configuration,
      digester,
    );
    if (
      Object.keys(input.registration).sort().join() !==
      "implementationDigest,manifest,manifestDigest"
    )
      throw invalid();
    const manifest = parseExtensionManifest(input.registration.manifest);
    const registration = Object.freeze({
      manifest,
      manifestDigest: input.registration.manifestDigest,
      implementationDigest: input.registration.implementationDigest,
    });
    if (
      configuration.pluginId !== manifest.pluginId ||
      configuration.pluginVersion !== manifest.version ||
      configuration.manifestDigest !== registration.manifestDigest ||
      configuration.implementationDigest !==
        registration.implementationDigest ||
      digester.sha256(extensionCanonicalJson(manifest)) !==
        registration.manifestDigest
    )
      throw invalid();
    validateExtensionConfiguration(manifest, configuration.parameters);
    const slots = new Set(manifest.credentialSlots.map((slot) => slot.id));
    if (
      configuration.credentialBindings.some(
        (binding) => !slots.has(binding.slotId),
      )
    )
      throw invalid();
    const target = parseExtensionExecutionTarget(input.target);
    return Object.freeze({
      configuration,
      registration,
      target,
      approvalRequirement: input.approvalRequirement,
    });
  } catch (error) {
    throw invalid(error);
  }
}
function invalid(cause?: unknown): Error {
  return new Error("extension_runtime_materialization_invalid", { cause });
}
