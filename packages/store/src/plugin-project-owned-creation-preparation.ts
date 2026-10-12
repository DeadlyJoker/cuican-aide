import {
  captureCreativeProjectCommitAuthority,
  assertCreativeProjectCommitCurrent,
  assertCreativeProjectCommitTransactionCurrent,
  deriveQualifiedPluginProjectCreationReceipt,
  qualifyPluginProjectCreationScope,
  type CreativeProjectCommitOptions,
  type OwnedCreativeProjectCreationInput,
  type OwnedCreativeProjectCreationReceiptInput,
} from "@crewon/application";
import {
  pluginInstallationRecord,
  extensionCanonicalJson,
} from "@crewon/domain";
import {
  creativeMutationIdentity,
  creativeStoreDigester,
  prepareCreativeMutation,
} from "./creative-project-store-records.ts";
import { assertCreativeProjectPluginCommitSelection } from "./creative-project-plugin-commit-support.ts";
/** Same original Store recipes and connection. Source identity is not the independent project policy. */
export async function prepareOwnedCreativeCreation(
  input:
    | OwnedCreativeProjectCreationReceiptInput
    | OwnedCreativeProjectCreationInput,
  options?: CreativeProjectCommitOptions,
  operation: "read" | "commit" = "read",
) {
  const creation = operation === "commit";
  const fields = pluginInstallationRecord(
    input,
    creation
      ? ["actor", "receipt", "creationScope", "project", "initialBrief"]
      : ["actor", "receipt", "creationScope"],
  );
  const reference =
    fields.creationScope as OwnedCreativeProjectCreationReceiptInput["creationScope"];
  const source = qualifyPluginProjectCreationScope(reference);
  if (source.entryPoint !== "creative-project")
    throw new Error("plugin_project_owned_creation_entry_mismatch");
  const authority = captureCreativeProjectCommitAuthority(options, {
    allowTextUiTransaction: false,
    allowCreationScope: true,
  });
  if (
    options?.creationScope !== reference ||
    authority === undefined ||
    authority.transaction === undefined
  )
    throw new Error("plugin_project_owned_creation_authority_required");
  assertCreativeProjectPluginCommitSelection(
    source.transaction,
    authority.transaction,
  );
  if (
    extensionCanonicalJson(source.transaction.pin) !==
    extensionCanonicalJson(authority.transaction.pin)
  )
    throw new Error("plugin_project_owned_creation_authority_mismatch");
  const original = creativeMutationIdentity({
    actor: fields.actor,
    receipt: fields.receipt,
    kind: "create-project",
  });
  for (const key of ["tenantId", "spaceId", "principalId", "actorId"] as const)
    if (original.actor[key] !== source.scope[key])
      throw new Error("plugin_project_owned_creation_owner_mismatch");
  const scoped = deriveQualifiedPluginProjectCreationReceipt(
    reference,
    original.receipt,
    creativeStoreDigester,
  );
  const identity = creativeMutationIdentity({
    actor: original.actor,
    receipt: scoped.receipt,
    kind: "create-project",
  });
  const prepared = creation
    ? prepareCreativeMutation("create-project", {
        actor: identity.actor,
        receipt: identity.receipt,
        project: fields.project,
        initialBrief: fields.initialBrief,
      })
    : null;
  await assertCreativeProjectCommitCurrent(authority);
  await source.assertCurrent();
  await source.transaction.assertCurrent();
  // The original Application's independent create policy is checked last,
  // after the source's final asynchronous approval work and before BEGIN.
  await assertCreativeProjectCommitTransactionCurrent(authority);
  source.assertActive();
  return Object.freeze({ source, authority, identity, prepared });
}
