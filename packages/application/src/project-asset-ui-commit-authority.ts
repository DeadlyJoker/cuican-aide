import {
  creativeProjectOpaqueId,
  extensionCanonicalJson,
  type InstalledPluginPackage,
  type PluginSelection,
  creativeProjectDigest,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { ProjectToolInstallationPin } from "./creative-project-run-commit-authority.ts";
import {
  parseProjectAssetMutationCommand,
  type ProjectAssetMutationKind,
  type ProjectAssetMutationCommand,
} from "./project-asset-commands.ts";
import type { ProjectAssetCommitAuthority } from "./project-asset-commit-authority.ts";
import {
  projectAssetAuthorityCopy,
  projectAssetAuthorityDenied,
  projectAssetAuthorityFields,
  projectAssetInstallationEvidence,
} from "./project-asset-qualification-data.ts";

export const PROJECT_ASSET_UI_MUTATION_KINDS = Object.freeze({
  "crewon.project-assets.v1.saveCandidate": "save-content",
  "crewon.project-assets.v1.selectRevision": "select-content",
  "crewon.project-assets.v1.setLocked": "set-lock",
  "crewon.project-assets.v1.saveReferenceCandidate": "save-reference",
  "crewon.project-assets.v1.selectReference": "select-reference",
} as const);
export type ProjectAssetUiMutationAction =
  keyof typeof PROJECT_ASSET_UI_MUTATION_KINDS;
export type ProjectAssetUiCommitTransactionAuthority = Readonly<{
  version: "crewon.project-asset-plugin-commit.v1";
  actor: ActorContext;
  installation: ProjectToolInstallationPin;
  contributionId: string;
  actionId: ProjectAssetUiMutationAction;
  input: unknown;
  intentRef?: Readonly<{ intentId: string; requestDigest: string }>;
  selection: PluginSelection;
  package: InstalledPluginPackage;
  /** External owner/profile/PDP checks only; never borrow the committing pool. */
  assertCurrent(): Promise<void>;
}>;
export function captureProjectAssetUiCommitTransaction(
  input: unknown,
): ProjectAssetUiCommitTransactionAuthority {
  const optional =
    input !== null &&
    typeof input === "object" &&
    Object.hasOwn(input, "intentRef");
  const v = projectAssetAuthorityFields(input, [
    ...(optional ? ["intentRef"] : []),
    "version",
    "actor",
    "installation",
    "contributionId",
    "actionId",
    "input",
    "selection",
    "package",
    "assertCurrent",
  ]);
  if (
    v.version !== "crewon.project-asset-plugin-commit.v1" ||
    typeof v.actionId !== "string" ||
    !Object.hasOwn(PROJECT_ASSET_UI_MUTATION_KINDS, v.actionId) ||
    typeof v.assertCurrent !== "function"
  )
    projectAssetAuthorityDenied();
  const evidence = projectAssetInstallationEvidence(v),
    current = v.assertCurrent.bind(input);
  const transaction: ProjectAssetUiCommitTransactionAuthority = Object.freeze({
    version: "crewon.project-asset-plugin-commit.v1",
    ...evidence,
    contributionId: creativeProjectOpaqueId(v.contributionId),
    actionId: v.actionId as ProjectAssetUiMutationAction,
    ...(optional ? { intentRef: captureIntentRef(v.intentRef) } : {}),
    input: projectAssetAuthorityCopy(v.input),
    assertCurrent: async () => {
      if ((await current()) !== undefined) projectAssetAuthorityDenied();
    },
  });
  projectAssetUiMutationCommand(transaction);
  return transaction;
}
export function projectAssetUiMutationCommand(
  transaction: ProjectAssetUiCommitTransactionAuthority,
): Readonly<{
  kind: ProjectAssetMutationKind;
  command: ProjectAssetMutationCommand;
}> {
  const kind = PROJECT_ASSET_UI_MUTATION_KINDS[transaction.actionId];
  if (kind === undefined) projectAssetAuthorityDenied();
  const v = projectAssetAuthorityFields(transaction.input, [
    "projectId",
    "assetId",
    "request",
    "idempotencyKey",
  ]);
  const request = projectAssetAuthorityFields(
    v.request,
    kind === "save-content"
      ? ["kind", "expectedAssetRevision", "briefRevision", "script", "content"]
      : kind === "select-content"
        ? ["expectedAssetRevision", "contentRevision"]
        : kind === "set-lock"
          ? ["expectedAssetRevision", "locked"]
          : kind === "save-reference"
            ? [
                "expectedAssetRevision",
                "assetContentRevision",
                "conceptAssetId",
                "selectionRevision",
              ]
            : ["expectedAssetRevision", "referenceRevision"],
  );
  const command = parseProjectAssetMutationCommand(kind, {
    ...request,
    projectId: v.projectId,
    assetId: v.assetId,
    idempotencyKey: v.idempotencyKey,
  });
  return Object.freeze({ kind, command });
}
export function assertProjectAssetUiMutationCommand(
  authority: ProjectAssetCommitAuthority | undefined,
  actor: ActorContext,
  kind: ProjectAssetMutationKind,
  command: ProjectAssetMutationCommand,
  _digester: ContentDigester,
): void {
  const transaction = authority?.uiTransaction;
  if (transaction === undefined) return;
  const expected = projectAssetUiMutationCommand(transaction);
  if (
    extensionCanonicalJson(actor) !==
      extensionCanonicalJson(transaction.actor) ||
    kind !== expected.kind ||
    extensionCanonicalJson(command) !== extensionCanonicalJson(expected.command)
  )
    projectAssetAuthorityDenied();
}

function captureIntentRef(input: unknown) {
  const v = projectAssetAuthorityFields(input, ["intentId", "requestDigest"]);
  return Object.freeze({
    intentId: creativeProjectOpaqueId(v.intentId),
    requestDigest: creativeProjectDigest(v.requestDigest),
  });
}
