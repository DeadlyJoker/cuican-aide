import {
  beginAssetVtwoMutation,
  type AssetCommitPlan,
} from "./project-asset-vtwo-recovery-commit.ts";
import { acceptAssetVtwoRecovery } from "./project-asset-vtwo-recovery-plan.ts";
import {
  prepareAssetMutation,
  persistAssetMutation,
} from "./project-asset-mutation-records.ts";
import {
  beginAssetIntentCommit,
  acceptAssetIntent,
} from "./project-asset-ui-intent-plan.ts";
import type {
  ProjectAssetCommitAuthority,
  ProjectGenerationImageResultVerifier,
} from "@crewon/application";
import {
  projectAssetRunMutationCommand,
  projectAssetUiMutationCommand,
  projectAssetMutationReceipt,
} from "@crewon/application";
import { extensionCanonicalJson, projectAssetFailure } from "@crewon/domain";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import {
  assetOwner,
  assetOwnerValues,
  assetLock,
  assetReceipt,
  assertAssetCommand,
  type AssetDialect,
  type AssetInput,
} from "./project-asset-store-support.ts";
import { loadProjectAssetCurrentImageSource } from "./project-asset-image-source.ts";
import { verifyProjectAssetMutationReference } from "./project-asset-reference-proof-plan.ts";

export function assertAssetReceiptQualification(
  authority: ProjectAssetCommitAuthority | undefined,
  input: AssetInput<"loadMutationReceipt">,
): void {
  const q = authority?.uiTransaction ?? authority?.runTransaction;
  if (!q) return;
  const expected = authority?.uiTransaction
    ? projectAssetUiMutationCommand(authority.uiTransaction)
    : {
        kind: "save-content" as const,
        command: projectAssetRunMutationCommand(
          authority!.runTransaction!,
          creativeStoreDigester,
        ),
      };
  const receipt = projectAssetMutationReceipt(
    q.actor,
    expected.kind,
    expected.command,
    creativeStoreDigester,
  );
  if (
    extensionCanonicalJson(q.actor) !== extensionCanonicalJson(input.actor) ||
    expected.kind !== input.kind ||
    extensionCanonicalJson(receipt) !== extensionCanonicalJson(input.receipt)
  )
    projectAssetFailure("project_asset_qualification_denied");
}
export function* commitAssetPlan(
  d: AssetDialect,
  input: AssetInput<"commitMutation">,
  authority: ProjectAssetCommitAuthority | undefined,
  verifier: ProjectGenerationImageResultVerifier | undefined,
  journalAvailable = false,
): AssetCommitPlan<
  Awaited<
    ReturnType<
      import("@crewon/application").ProjectAssetStore["commitMutation"]
    >
  >
> {
  assertAssetCommand(authority, input);
  const owner = assetOwner(input.actor),
    c = input.command;
  yield* assetLock(d, [
    "project-asset-receipt",
    d.schema,
    ...assetOwnerValues(owner),
    input.actor.actorId,
    input.kind,
    input.receipt.idempotencyKey,
  ]);
  const intent = yield* beginAssetIntentCommit(
    d,
    journalAvailable,
    authority?.uiTransaction,
    input,
  );
  const v2Intent = yield* beginAssetVtwoMutation(d, input, authority);
  yield* assetLock(d, [
    "creative-project-project",
    d.schema,
    input.actor.tenantId,
    input.actor.spaceId,
    c.projectId,
  ]);
  const previous = yield* assetReceipt(d, input);
  if (previous !== null) {
    if (previous.referenceRevision !== null)
      yield* verifyProjectAssetMutationReference(
        d,
        input.actor,
        previous.referenceRevision,
        verifier,
        authority,
      );
    if (intent) yield* acceptAssetIntent(d, intent, previous);
    yield* acceptAssetVtwoRecovery(d, v2Intent, previous.asset.updatedAt);
    return previous;
  }
  const source =
    input.kind === "save-reference" && "conceptAssetId" in c
      ? yield* loadProjectAssetCurrentImageSource(
          d,
          input.actor,
          {
            projectId: c.projectId,
            conceptAssetId: c.conceptAssetId,
            selectionRevision: c.selectionRevision,
          },
          verifier,
        )
      : undefined;
  const result = yield* prepareAssetMutation(d, input, source);
  if (input.kind === "save-content")
    yield {
      foundationDownstream: { actor: input.actor, projectId: c.projectId },
    };
  if (input.kind === "select-reference" && result.referenceRevision !== null)
    yield* verifyProjectAssetMutationReference(
      d,
      input.actor,
      result.referenceRevision,
      verifier,
      authority,
    );
  yield* persistAssetMutation(d, input, result, intent);
  if (intent) yield* acceptAssetIntent(d, intent, result);
  yield* acceptAssetVtwoRecovery(d, v2Intent, result.asset.updatedAt);
  return result;
}
