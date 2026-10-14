import {
  captureProjectAssetRunCommitTransaction,
  type ProjectAssetRunCommitTransactionAuthority,
} from "./project-asset-run-commit-authority.ts";
import { registerTrustedRunProjectReadSource } from "./plugin-project-read-scope.ts";
import {
  extensionCanonicalJson,
  parsePluginTaskAdmissionPin,
  parsePluginProjectWorkspaceOwnerScope,
} from "@crewon/domain";

/** Actual independently authorized asset_save dispatch lends only its bounded
 * dependency reads. This scope never substitutes for the original writer's
 * Tool, installation, asset stage, namespace, queue lease or final checks.
 */
export async function issuePluginProjectAssetRunMutationReadScope(
  input: Readonly<{
    authority: ProjectAssetRunCommitTransactionAuthority;
    assertActive(): void;
  }>,
) {
  const q = captureProjectAssetRunCommitTransaction(input.authority);
  const active = () => input.assertActive();
  active();
  await q.assertCurrent();
  active();
  const pin = parsePluginTaskAdmissionPin(
    Object.fromEntries(
      [
        "tenantId",
        "spaceId",
        "profileId",
        "pluginId",
        "publisherId",
        "version",
        "packageDigest",
        "selectionRevision",
        "principalId",
        "actorId",
        "contributionId",
        "action",
        "authorityEpoch",
      ].map((key) => [key, q.admission[key as keyof typeof q.admission]]),
    ),
  );
  const request = Object.freeze({
    action: "crewon.project-asset-run-mutation-read.v1" as const,
    input: Object.freeze({ projectId: q.assetStageAdmission.projectId }),
  });
  return registerTrustedRunProjectReadSource({
    assetRunMutationAuthority: q,
    purpose: "read",
    scope: parsePluginProjectWorkspaceOwnerScope({
      ...q.actor,
      profileId: q.installation.profileId,
      pluginId: q.installation.pluginId,
      publisherId: q.installation.publisherId,
    }),
    snapshot: Object.freeze({
      pin,
      context: Object.freeze({ selection: q.selection, package: q.package }),
      fingerprint: extensionCanonicalJson({
        pin,
        request,
        runId: q.run.runId,
        receiptId: q.receipt.receiptId,
      }),
    }),
    request,
    methods: Object.freeze([
      "loadProject",
      "loadBrief",
      "loadArtifact",
      "loadRevision",
      "loadAsset",
      "loadReferenceRevision",
      "listAssets",
      "listRevisions",
      "listReferences",
    ]),
    assertActive: active,
    assertCurrent: async () => {
      active();
      await q.assertCurrent();
      active();
    },
  });
}
