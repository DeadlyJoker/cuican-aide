import {
  captureProjectFoundationRunCommitTransaction,
  type ProjectFoundationRunCommitTransactionAuthority,
} from "./project-foundation-run-commit-authority.ts";
import { registerTrustedRunProjectReadSource } from "./plugin-project-read-scope.ts";
import {
  extensionCanonicalJson,
  parsePluginTaskAdmissionPin,
  parsePluginProjectWorkspaceOwnerScope,
} from "@crewon/domain";
/** Actual leased proposal-save dispatch lends only its bounded preparation reads. The original writer must independently recheck Tool and Run evidence. */
export async function issuePluginProjectFoundationRunMutationReadScope(
  input: Readonly<{
    authority: ProjectFoundationRunCommitTransactionAuthority;
    assertActive(): void;
  }>,
) {
  const q = captureProjectFoundationRunCommitTransaction(input.authority);
  const active = () => {
    input.assertActive();
  };
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
      ].map((k) => [k, q.admission[k as keyof typeof q.admission]]),
    ),
  );
  const request = Object.freeze({
    action: "crewon.project-foundation-run-mutation-read.v1" as const,
    input: Object.freeze({ projectId: q.foundationAdmission.projectId }),
  });
  return registerTrustedRunProjectReadSource({
    foundationRunMutationAuthority: q,
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
      "loadFoundation",
      "loadSource",
      "loadProposal",
    ]),
    assertActive: active,
    assertCurrent: async () => {
      active();
      await q.assertCurrent();
      active();
    },
  });
}
