import {
  creativeProjectDigest,
  creativeProjectOpaqueId,
  pluginInstallationRecord,
  extensionCanonicalJson,
  parsePluginProjectWorkspaceOwnerScope,
  type PluginProjectWorkspaceOwnerScope,
} from "@crewon/domain";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { CreativeProjectMutationReceipt } from "./creative-project-store-port.ts";

export type PluginProjectCreationEntryPoint =
  | "creative-project"
  | "project-foundation";

/** Data derivation only. It grants neither creation nor access to a saved receipt. */
export function derivePluginProjectCreationReceipt(
  input: Readonly<{
    scope: PluginProjectWorkspaceOwnerScope;
    entryPoint: PluginProjectCreationEntryPoint;
    externalReceipt: CreativeProjectMutationReceipt;
  }>,
  digester: ContentDigester,
) {
  const value = pluginInstallationRecord(input, [
    "scope",
    "entryPoint",
    "externalReceipt",
  ]);
  const scope = parsePluginProjectWorkspaceOwnerScope(value.scope);
  const entryPoint = value.entryPoint;
  if (entryPoint !== "creative-project" && entryPoint !== "project-foundation")
    throw new Error("plugin_project_creation_receipt_entry_invalid");
  const external = pluginInstallationRecord(value.externalReceipt, [
    "idempotencyKey",
    "requestDigest",
  ]);
  const externalKey = creativeProjectOpaqueId(external.idempotencyKey);
  const requestDigest = creativeProjectDigest(external.requestDigest);
  // A retry may prepare a different server-generated projectId. Stable ownership
  // and the original caller key identify creation; that new ID must not enter this key.
  const namespaceDigest = creativeProjectDigest(
    digester.sha256(
      extensionCanonicalJson({
        schemaVersion: "crewon.plugin-project-creation-receipt.v1",
        scope,
        entryPoint,
        externalKey,
      }),
    ),
  );
  return Object.freeze({
    schemaVersion: "crewon.plugin-project-creation-receipt.v1" as const,
    scope,
    entryPoint,
    externalKey,
    receipt: Object.freeze({
      idempotencyKey: `pc1_${namespaceDigest.slice("sha256:".length)}`,
      requestDigest,
    }),
  });
}
