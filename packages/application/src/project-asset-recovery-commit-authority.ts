import {
  extensionCanonicalJson,
  parseInstalledPluginPackage,
  parsePluginSelection,
  validateCreativeProjectActor,
  creativeProjectOpaqueId,
  type InstalledPluginPackage,
  type PluginSelection,
} from "@crewon/domain";
import {
  parseProjectAssetRecoveryActionRequest,
  type ProjectAssetRecoveryActionRequest,
} from "@crewon/contracts/project-asset-recovery";
import {
  parseProjectToolInstallationPin,
  type ProjectToolInstallationPin,
} from "./creative-project-run-commit-authority.ts";
import type { ActorContext } from "./authorization-port.ts";

/** Independent recovery read/ACK qualification. It cannot authorize a text edit or a Run. */
export type ProjectAssetRecoveryCommitTransactionAuthority = Readonly<{
  version: "crewon.project-asset-recovery-commit.v1";
  actor: ActorContext;
  installation: ProjectToolInstallationPin;
  contributionId: string;
  actionId: ProjectAssetRecoveryActionRequest["action"];
  input: ProjectAssetRecoveryActionRequest["input"];
  selection: PluginSelection;
  package: InstalledPluginPackage;
  /** External UI/profile/policy only, never borrow the journal's committing pool. */
  assertCurrent(): Promise<void>;
}>;
export type ProjectAssetRecoveryCommitAuthority = Readonly<{
  assertActive(): void;
  assertCurrent(): Promise<void>;
  assertTransactionCurrent(): Promise<void>;
  recoveryTransaction: ProjectAssetRecoveryCommitTransactionAuthority;
}>;
export function captureProjectAssetRecoveryCommitTransaction(
  input: unknown,
): ProjectAssetRecoveryCommitTransactionAuthority {
  const fields = data(input, [
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
    fields.version !== "crewon.project-asset-recovery-commit.v1" ||
    typeof fields.assertCurrent !== "function"
  )
    invalid();
  const actor = validateCreativeProjectActor(clone(fields.actor));
  const installation = parseProjectToolInstallationPin(fields.installation);
  const selection = parsePluginSelection(clone(fields.selection));
  const pkg = parseInstalledPluginPackage(clone(fields.package));
  if (
    actor.tenantId !== installation.tenantId ||
    actor.spaceId !== installation.spaceId ||
    selection.state !== "enabled" ||
    selection.revision !== installation.selectionRevision ||
    selection.selectedPackageDigest !== installation.packageDigest ||
    pkg.packageDigest !== installation.packageDigest ||
    pkg.version !== installation.version ||
    (
      ["tenantId", "spaceId", "profileId", "pluginId", "publisherId"] as const
    ).some(
      (key) =>
        installation[key] !== selection[key] || installation[key] !== pkg[key],
    )
  )
    invalid();
  const request = parseProjectAssetRecoveryActionRequest({
    action: fields.actionId,
    input: fields.input,
  });
  const current = fields.assertCurrent.bind(input);
  return Object.freeze({
    version: "crewon.project-asset-recovery-commit.v1",
    actor,
    installation,
    contributionId: creativeProjectOpaqueId(fields.contributionId),
    actionId: request.action,
    input: request.input,
    selection,
    package: pkg,
    assertCurrent: async () => {
      const result: unknown = await current();
      if (result !== undefined) invalid();
    },
  });
}
export function captureProjectAssetRecoveryCommitAuthority(
  input: unknown,
): ProjectAssetRecoveryCommitAuthority {
  const fields = data(input, [
    "assertActive",
    "assertCurrent",
    "assertTransactionCurrent",
    "recoveryTransaction",
  ]);
  if (
    typeof fields.assertActive !== "function" ||
    typeof fields.assertCurrent !== "function" ||
    typeof fields.assertTransactionCurrent !== "function"
  )
    invalid();
  const active = fields.assertActive.bind(input),
    current = fields.assertCurrent.bind(input),
    transactionCurrent = fields.assertTransactionCurrent.bind(input);
  return Object.freeze({
    assertTransactionCurrent: async () => {
      if ((await transactionCurrent()) !== undefined) invalid();
    },
    assertActive: () => {
      const result: unknown = active();
      if (result !== undefined) {
        if (
          result !== null &&
          (typeof result === "object" || typeof result === "function")
        )
          try {
            void Promise.prototype.then.call(
              result,
              () => undefined,
              () => undefined,
            );
          } catch {
            /* Do not inspect arbitrary thenable getters. */
          }
        invalid();
      }
    },
    assertCurrent: async () => {
      const result: unknown = await current();
      if (result !== undefined) invalid();
    },
    recoveryTransaction: captureProjectAssetRecoveryCommitTransaction(
      fields.recoveryTransaction,
    ),
  });
}
function data(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== keys.length
  )
    invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !keys.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    )
      invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function clone(input: unknown): unknown {
  const copy: unknown = JSON.parse(extensionCanonicalJson(input));
  return freeze(copy);
}
function freeze(input: unknown): unknown {
  if (input !== null && typeof input === "object") {
    for (const child of Object.values(input)) freeze(child);
    Object.freeze(input);
  }
  return input;
}
function invalid(): never {
  throw new Error("project_asset_recovery_commit_authority_invalid");
}
