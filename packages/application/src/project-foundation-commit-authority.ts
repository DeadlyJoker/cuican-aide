import {
  parseInstalledPluginPackage,
  parsePluginSelection,
  parsePluginTaskAdmissionPin,
  validateCreativeProjectActor,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import { captureProjectFoundationRunCommitTransaction } from "./project-foundation-run-commit-authority.ts";
import type {
  ProjectFoundationCommitAuthority,
  ProjectFoundationCommitOptions,
  ProjectFoundationMutationKind,
  ProjectFoundationPluginCommitTransactionAuthority,
} from "./project-foundation-store-port.ts";

export const PROJECT_FOUNDATION_MUTATION_ACTIONS: Readonly<
  Record<ProjectFoundationMutationKind, string>
> = Object.freeze({
  "create-project": "crewon.project-foundation.v1.createProject",
  "update-parameters": "crewon.project-foundation.v1.updateParameters",
  "append-source": "crewon.project-foundation.v1.appendSource",
  "save-proposal": "crewon.project-foundation.v1.saveProposal",
  "confirm-proposal": "crewon.project-foundation.v1.confirmProposal",
  "choose-direct-script": "crewon.project-foundation.v1.chooseDirectScript",
});

/** Capture only this protocol's own data fields before any asynchronous policy or lock work. */
export function captureProjectFoundationCommitAuthority(
  options: ProjectFoundationCommitOptions | undefined,
): ProjectFoundationCommitAuthority | undefined {
  if (options === undefined) return undefined;
  const fields = ownDataFields(options, ["authority"]);
  if (fields.authority === undefined) return undefined;
  const input = fields.authority;
  const methods = ownDataFields(
    input,
    ["assertCurrent", "assertActive", "transaction", "runTransaction"],
    ["assertCurrent", "assertActive"],
  );
  if (
    typeof methods.assertCurrent !== "function" ||
    typeof methods.assertActive !== "function" ||
    (methods.transaction !== undefined && methods.runTransaction !== undefined)
  )
    invalid();
  return Object.freeze({
    assertCurrent: methods.assertCurrent.bind(input),
    assertActive: methods.assertActive.bind(input),
    ...(methods.transaction === undefined
      ? {}
      : { transaction: captureTransaction(methods.transaction) }),
    ...(methods.runTransaction === undefined
      ? {}
      : {
          runTransaction: captureProjectFoundationRunCommitTransaction(
            methods.runTransaction,
          ),
        }),
  });
}

function captureTransaction(
  input: unknown,
): ProjectFoundationPluginCommitTransactionAuthority {
  const fields = ownDataFields(
    input,
    ["version", "pin", "selection", "package", "assertCurrent"],
    ["version", "pin", "selection", "package", "assertCurrent"],
  );
  if (
    fields.version !== "crewon.project-foundation-plugin-commit.v1" ||
    typeof fields.assertCurrent !== "function"
  )
    invalid();
  let pin: ProjectFoundationPluginCommitTransactionAuthority["pin"];
  let selection: ProjectFoundationPluginCommitTransactionAuthority["selection"];
  let pkg: ProjectFoundationPluginCommitTransactionAuthority["package"];
  try {
    pin = parsePluginTaskAdmissionPin(fields.pin);
    selection = parsePluginSelection(fields.selection);
    pkg = parseInstalledPluginPackage(fields.package);
  } catch {
    invalid();
  }
  if (
    !Object.values(PROJECT_FOUNDATION_MUTATION_ACTIONS).includes(pin.action) ||
    selection.state !== "enabled" ||
    selection.revision !== pin.selectionRevision ||
    selection.selectedPackageDigest !== pin.packageDigest ||
    pkg.packageDigest !== pin.packageDigest ||
    pkg.version !== pin.version ||
    (
      ["tenantId", "spaceId", "profileId", "pluginId", "publisherId"] as const
    ).some((key) => selection[key] !== pin[key] || pkg[key] !== pin[key])
  )
    invalid();
  const current = fields.assertCurrent.bind(input);
  return Object.freeze({
    version: "crewon.project-foundation-plugin-commit.v1",
    pin,
    selection,
    package: pkg,
    assertCurrent: async () => {
      const result: unknown = await current();
      if (result !== undefined) asyncResultInvalid();
    },
  });
}

/** Validate the exact new action and actual actor; this does not read or grant installation state. */
export function qualifyProjectFoundationPluginCommit(
  authority: ProjectFoundationCommitAuthority | undefined,
  actor: ActorContext,
  kind: ProjectFoundationMutationKind,
): ProjectFoundationPluginCommitTransactionAuthority | undefined {
  const transaction = authority?.transaction;
  if (transaction === undefined) return undefined;
  // Capture defensively so a direct Store caller cannot bypass the protocol's version/shape check.
  const captured = captureTransaction(transaction);
  let checked: ActorContext;
  try {
    checked = validateCreativeProjectActor(actor);
  } catch {
    pinMismatch();
  }
  if (
    !Object.hasOwn(PROJECT_FOUNDATION_MUTATION_ACTIONS, kind) ||
    captured.pin.action !== PROJECT_FOUNDATION_MUTATION_ACTIONS[kind] ||
    (["tenantId", "spaceId", "principalId", "actorId"] as const).some(
      (key) => captured.pin[key] !== checked[key],
    )
  )
    pinMismatch();
  return captured;
}

/** Reject asynchronous active checks without invoking arbitrary thenable getters. */
export function assertProjectFoundationCommitActive(
  authority: ProjectFoundationCommitAuthority | undefined,
): void {
  if (authority === undefined) return;
  const result: unknown = authority.assertActive();
  if (result === undefined) return;
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
      // Observe native Promise rejection, but never execute a caller-owned then method.
    }
  throw new Error("project_foundation_commit_authority_sync_required");
}

export async function assertProjectFoundationCommitCurrent(
  authority: ProjectFoundationCommitAuthority | undefined,
): Promise<void> {
  if (authority === undefined) return;
  const result: unknown = await authority.assertCurrent();
  if (result !== undefined) asyncResultInvalid();
}

/** The Store supplies installation checks on its borrowed transaction connection separately. */
export async function assertProjectFoundationCommitTransactionCurrent(
  authority: ProjectFoundationCommitAuthority | undefined,
): Promise<void> {
  const transaction = authority?.transaction ?? authority?.runTransaction;
  if (transaction === undefined)
    return assertProjectFoundationCommitCurrent(authority);
  const result: unknown = await transaction.assertCurrent();
  if (result !== undefined) asyncResultInvalid();
}

function ownDataFields(
  input: unknown,
  allowed: readonly string[],
  required: readonly string[] = [],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    invalid();
  const keys = Reflect.ownKeys(input);
  if (
    keys.length > allowed.length ||
    required.some((key) => !Object.hasOwn(input, key))
  )
    invalid();
  const fields: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      !descriptor.enumerable
    )
      invalid();
    fields[key] = descriptor.value;
  }
  return fields;
}

function invalid(): never {
  throw new Error("project_foundation_commit_authority_invalid");
}
function pinMismatch(): never {
  throw new Error("project_foundation_plugin_commit_pin_mismatch");
}
function asyncResultInvalid(): never {
  throw new Error("project_foundation_commit_authority_async_result_invalid");
}
