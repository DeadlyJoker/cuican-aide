import {
  qualifyPluginProjectMutationScope,
  scopedPluginMetadataReceipt,
  type PluginProjectMutationScope,
  type CreativeProjectCommitAuthority,
} from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import { creativeProjectPluginCommitQualification } from "./creative-project-plugin-commit-support.ts";
import {
  creativeStoreDigester,
  type creativeMutationIdentity,
} from "./creative-project-store-records.ts";
export async function prepareOwnedMetadataMutation(
  scope: PluginProjectMutationScope,
  authority: CreativeProjectCommitAuthority | undefined,
  identity: ReturnType<typeof creativeMutationIdentity>,
) {
  const source = qualifyPluginProjectMutationScope(scope);
  const qualification = creativeProjectPluginCommitQualification(
    authority,
    identity.actor,
    identity.kind,
  );
  if (
    qualification === undefined ||
    extensionCanonicalJson(qualification.pin) !==
      extensionCanonicalJson(source.snapshot.pin) ||
    extensionCanonicalJson(qualification.selection) !==
      extensionCanonicalJson(source.snapshot.context.selection) ||
    extensionCanonicalJson(qualification.package) !==
      extensionCanonicalJson(source.snapshot.context.package)
  )
    throw new Error("plugin_project_mutation_authority_mismatch");
  const input = source.request.input as Readonly<Record<string, unknown>>;
  const command = {
    ...(input.request as object),
    ...Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== "request"),
    ),
  };
  const receipt = scopedPluginMetadataReceipt(
    scope,
    identity.actor,
    command as never,
    {
      idempotencyKey: String(input.idempotencyKey),
      requestDigest: identity.receipt.requestDigest,
    },
    creativeStoreDigester,
  );
  if (receipt.idempotencyKey !== identity.receipt.idempotencyKey)
    throw new Error("plugin_project_mutation_receipt_mismatch");
  await source.assertCurrent();
  source.assertActive();
  return Object.freeze({ ...source, projectId: String(input.projectId) });
}

export type OwnedMetadataMutation = Awaited<
  ReturnType<typeof prepareOwnedMetadataMutation>
>;
