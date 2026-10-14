import {
  captureProjectAssetRunReadAuthority,
  PROJECT_ASSET_RUN_READ_METHODS,
  type ProjectAssetRunReadAuthority,
} from "./project-asset-run-read-authority.ts";
import { parseProjectAssetToolCommand } from "@crewon/contracts/project-asset-tools";
import { registerTrustedRunProjectReadSource } from "./plugin-project-read-scope.ts";
import {
  extensionCanonicalJson,
  parsePluginTaskAdmissionPin,
  parsePluginProjectWorkspaceOwnerScope,
} from "@crewon/domain";

/** Independent original readonly Tool/receipt issuer. No writer or receipts are exposed by its view. */
export async function issuePluginProjectAssetRunReadScope(
  input: Readonly<{
    authority: ProjectAssetRunReadAuthority;
    assertActive(): void;
  }>,
) {
  const q = captureProjectAssetRunReadAuthority(input.authority),
    active = input.assertActive.bind(input);
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
  const inputCommand = parseProjectAssetToolCommand(
    PROJECT_ASSET_RUN_READ_METHODS[q.operationId],
    JSON.parse(q.commandInput),
  );
  const request = Object.freeze({
    action: "crewon.project-asset-run-read.v1" as const,
    input: Object.freeze({
      projectId: inputCommand.projectId,
      ...("assetId" in inputCommand ? { assetId: inputCommand.assetId } : {}),
      ...("contentRevision" in inputCommand
        ? { contentRevision: inputCommand.contentRevision }
        : {}),
    }),
  });
  return registerTrustedRunProjectReadSource({
    purpose: "read",
    assetRunReadAuthority: q,
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
      "loadAsset",
      "loadRevision",
      "loadReferenceRevision",
      ...(q.operationId === "asset_list" ? ["listAssets"] : []),
      ...(q.operationId === "asset_history" ? ["listRevisions"] : []),
    ]),
    assertActive: active,
    assertCurrent: async () => {
      active();
      await q.assertCurrent();
      active();
    },
  });
}
