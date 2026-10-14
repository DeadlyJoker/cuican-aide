import {
  captureCreativeProjectRunCommitTransaction,
  type CreativeProjectRunCommitTransactionAuthority,
} from "./creative-project-run-commit-authority.ts";
import {
  captureProjectOutlineRunCommitTransaction,
  type ProjectOutlineRunCommitTransactionAuthority,
} from "./project-outline-run-commit-authority.ts";
import { registerTrustedRunProjectReadSource } from "./plugin-project-read-scope.ts";
import {
  extensionCanonicalJson,
  parsePluginTaskAdmissionPin,
  parsePluginProjectWorkspaceOwnerScope,
} from "@crewon/domain";

type Authority =
  | CreativeProjectRunCommitTransactionAuthority
  | ProjectOutlineRunCommitTransactionAuthority;
/** Bounded dependencies of the actual text Tool dispatch. It never qualifies its writer. */
export async function issuePluginProjectTextRunMutationReadScope(
  input: Readonly<{
    authority: Authority;
    assertActive(): void;
  }>,
) {
  const structured =
    Object.getOwnPropertyDescriptor(input.authority, "version")?.value ===
    "crewon.project-outline-run-commit.v2";
  const q = structured
    ? captureProjectOutlineRunCommitTransaction(input.authority)
    : captureCreativeProjectRunCommitTransaction(input.authority);
  if (
    !q.projectStageAdmission ||
    ![
      "outline_save",
      "script_save",
      "text_select",
      "text_lock",
      "outline_change",
    ].includes(q.operationId)
  )
    throw new Error("plugin_project_text_mutation_read_denied");
  const command = JSON.parse(q.commandInput) as Record<string, unknown>;
  if (command.projectId !== q.projectStageAdmission.projectId)
    throw new Error("plugin_project_text_mutation_read_target_mismatch");
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
      ].map((k) => [k, q.admission[k as keyof typeof q.admission]]),
    ),
  );
  const request = Object.freeze({
    action: structured
      ? ("crewon.project-outline-run-mutation-read.v1" as const)
      : ("crewon.project-text-run-mutation-read.v1" as const),
    input: Object.freeze({ projectId: q.projectStageAdmission.projectId }),
  });
  return registerTrustedRunProjectReadSource({
    ...(structured
      ? {
          outlineRunMutationAuthority:
            q as ProjectOutlineRunCommitTransactionAuthority,
        }
      : {
          creativeRunMutationAuthority:
            q as CreativeProjectRunCommitTransactionAuthority,
        }),
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
      "loadOutline",
      "loadScript",
      "loadArtifact",
      "loadRevision",
      "loadOutlineSourceRevision",
      "loadStructuredRevision",
      "loadFoundation",
    ]),
    assertActive: active,
    assertCurrent: async () => {
      active();
      await q.assertCurrent();
      active();
    },
  });
}
