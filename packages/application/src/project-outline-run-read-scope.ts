import {
  captureProjectOutlineRunReadAuthority,
  type ProjectOutlineRunReadAuthority,
} from "./project-outline-run-read-authority.ts";
import { registerTrustedRunProjectReadSource } from "./plugin-project-read-scope.ts";
import {
  extensionCanonicalJson,
  parsePluginTaskAdmissionPin,
  parsePluginProjectWorkspaceOwnerScope,
} from "@crewon/domain";

/** Private Worker issuer for this exact read Tool. No mutation or source-upload grant. */
export async function issuePluginProjectOutlineRunReadScope(
  input: Readonly<{
    authority: ProjectOutlineRunReadAuthority;
    assertActive(): void;
  }>,
) {
  const q = captureProjectOutlineRunReadAuthority(input.authority);
  const active = input.assertActive.bind(input);
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
    action: "crewon.project-outline-context-read.v1" as const,
    input: Object.freeze({ projectId: q.projectStageAdmission.projectId }),
  });
  return registerTrustedRunProjectReadSource({
    purpose: "read",
    outlineRunReadAuthority: q,
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
      "loadFoundation",
      "loadOutline",
      "loadArtifact",
      "loadStructuredRevision",
    ]),
    assertActive: active,
    assertCurrent: async () => {
      active();
      await q.assertCurrent();
      active();
    },
  });
}
