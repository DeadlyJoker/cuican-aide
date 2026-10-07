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
  "crewon.project-assets.v2.saveCandidate": "save-content",
  "crewon.project-assets.v2.selectRevision": "select-content",
  "crewon.project-assets.v2.setLocked": "set-lock",
  "crewon.project-assets.v2.saveReferenceCandidate": "save-reference",
  "crewon.project-assets.v2.selectReference": "select-reference",
} as const);
/** The persisted V1 recovery journal intentionally retains its original action set. */
export type ProjectAssetUiMutationAction = Extract<
  keyof typeof PROJECT_ASSET_UI_MUTATION_KINDS,
  `crewon.project-assets.v1.${string}`
>;
export type ProjectAssetVersionedUiMutationAction =
  keyof typeof PROJECT_ASSET_UI_MUTATION_KINDS;
export type ProjectAssetUiCommitTransactionAuthority = Readonly<{
  version:
    | "crewon.project-asset-plugin-commit.v1"
    | "crewon.project-asset-plugin-commit.v2";
  actor: ActorContext;
  installation: ProjectToolInstallationPin;
  contributionId: string;
  actionId: ProjectAssetVersionedUiMutationAction;
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
    (v.version !== "crewon.project-asset-plugin-commit.v1" &&
      v.version !== "crewon.project-asset-plugin-commit.v2") ||
    typeof v.actionId !== "string" ||
    !Object.hasOwn(PROJECT_ASSET_UI_MUTATION_KINDS, v.actionId) ||
    typeof v.assertCurrent !== "function"
  )
    projectAssetAuthorityDenied();
  if (
    v.version !==
      (v.actionId.startsWith("crewon.project-assets.v2.")
        ? "crewon.project-asset-plugin-commit.v2"
        : "crewon.project-asset-plugin-commit.v1") ||
    (v.version === "crewon.project-asset-plugin-commit.v2" && optional)
  )
    projectAssetAuthorityDenied();
  const evidence = projectAssetInstallationEvidence(v),
    current = v.assertCurrent.bind(input);
  const transaction: ProjectAssetUiCommitTransactionAuthority = Object.freeze({
    version: v.version,
    ...evidence,
    contributionId: creativeProjectOpaqueId(v.contributionId),
    actionId: v.actionId as ProjectAssetVersionedUiMutationAction,
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
