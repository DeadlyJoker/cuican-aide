import {
  parseProjectAssetRecoveryV2Request,
  isProjectAssetRecoveryV2Action,
  parseProjectAssetV2WriteRequest,
  type ProjectAssetRecoveryV2Request,
  type ProjectAssetV2WriteRequest,
} from "@crewon/contracts/project-asset-recovery-v2";
import {
  parseProjectAssetUiIntentScope,
  type ProjectAssetUiIntentScope,
  type InstalledPluginPackage,
  type PluginSelection,
} from "@crewon/domain";
import {
  projectAssetOwnFields,
  projectAssetBoundMethod,
} from "./project-asset-application-support.ts";
import { projectAssetInstallationEvidence } from "./project-asset-qualification-data.ts";
import { projectMediaResultAssertVoid } from "./project-media-result-record.ts";
import {
  assetV2RecoveryInvalid,
  type ProjectAssetV2RecoveryRecord,
} from "./project-asset-v2-recovery-record.ts";
export type ProjectAssetV2RecoveryAuthority = Readonly<{
  version: "crewon.project-asset-v2-recovery-authority.v1";
  scope: ProjectAssetUiIntentScope;
  selection: PluginSelection;
  package: InstalledPluginPackage;
  request: ProjectAssetV2WriteRequest | ProjectAssetRecoveryV2Request;
  assertCurrent(): Promise<void>;
  assertTransactionCurrent(): Promise<void>;
  assertActive(): void;
}>;
export function captureAssetV2RecoveryAuthority(
  input: unknown,
): ProjectAssetV2RecoveryAuthority {
  const r = projectAssetOwnFields(input, [
    "version",
    "scope",
    "selection",
    "package",
    "request",
    "assertCurrent",
    "assertTransactionCurrent",
    "assertActive",
  ]);
  if (r.version !== "crewon.project-asset-v2-recovery-authority.v1")
    assetV2RecoveryInvalid();
  const scope = parseProjectAssetUiIntentScope(r.scope),
    evidence = projectAssetInstallationEvidence({
      ...scope,
      selection: r.selection,
      package: r.package,
    });
  const q = projectAssetOwnFields(r.request, ["action", "input"]),
    request = isProjectAssetRecoveryV2Action(q.action)
      ? parseProjectAssetRecoveryV2Request(q)
      : parseProjectAssetV2WriteRequest(q);
  const current = projectAssetBoundMethod<() => Promise<void>>(
      input,
      "assertCurrent",
    ),
    transaction = projectAssetBoundMethod<() => Promise<void>>(
      input,
      "assertTransactionCurrent",
    ),
    active = projectAssetBoundMethod<() => void>(input, "assertActive");
  return Object.freeze({
    version: r.version,
    scope,
    selection: evidence.selection,
    package: evidence.package,
    request,
    assertCurrent: async () => projectMediaResultAssertVoid(await current()),
    assertTransactionCurrent: async () =>
      projectMediaResultAssertVoid(await transaction()),
    assertActive: () => projectMediaResultAssertVoid(active()),
  });
}
/** Parent-owned intent and original receipt share the same SQLite/PostgreSQL connection. */
export interface ProjectAssetV2RecoveryStore {
  migrate(): Promise<void>;
  stage(
    input: Readonly<{ at: string }>,
    authority: ProjectAssetV2RecoveryAuthority,
  ): Promise<ProjectAssetV2RecoveryRecord>;
  getPending(
    authority: ProjectAssetV2RecoveryAuthority,
  ): Promise<ProjectAssetV2RecoveryRecord | null>;
  loadIntent(
    authority: ProjectAssetV2RecoveryAuthority,
  ): Promise<ProjectAssetV2RecoveryRecord | null>;
  cancelPending(
    input: Readonly<{ at: string }>,
    authority: ProjectAssetV2RecoveryAuthority,
  ): Promise<ProjectAssetV2RecoveryRecord>;
  acknowledge(
    input: Readonly<{ at: string }>,
    authority: ProjectAssetV2RecoveryAuthority,
  ): Promise<
    Readonly<{
      record: ProjectAssetV2RecoveryRecord;
      disposition: "acknowledged" | "replayed";
    }>
  >;
}
