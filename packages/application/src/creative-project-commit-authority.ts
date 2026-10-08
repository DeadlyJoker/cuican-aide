import { captureProjectTextUiCommitTransaction } from "./project-text-ui-commit-authority.ts";
import { captureProjectOutlineUiCommitTransaction } from "./project-outline-ui-commit-authority.ts";
import { captureProjectTextPlanSelectionCommitAuthority } from "./project-text-plan-authority.ts";
import type {
  CreativeProjectCommitAuthority,
  CreativeProjectCommitOptions,
  CreativeProjectPluginCommitTransactionAuthority,
} from "./creative-project-store-port.ts";
import {
  parseInstalledPluginPackage,
  parsePluginSelection,
  parsePluginTaskAdmissionPin,
  type PluginTaskAdmissionPin,
  type PluginSelection,
  type InstalledPluginPackage,
} from "@crewon/domain";
import type { ProjectGenerationExecutionAuthority } from "./project-generation-execution-authority.ts";
import { captureCreativeProjectRunCommitTransaction } from "./creative-project-run-commit-authority.ts";

/** Capture distinct complete and transaction-safe fences before any await or lock acquisition. */
export function captureCreativeProjectTransactionAuthority(
  input: ProjectGenerationExecutionAuthority,
): Readonly<{
  preflight: CreativeProjectCommitAuthority;
  transaction: CreativeProjectCommitAuthority;
}> {
  const methods = ownDataFields(input, [
    "assertCurrent",
    "assertTransactionCurrent",
    "assertActive",
  ]);
  if (
    typeof methods.assertCurrent !== "function" ||
    typeof methods.assertTransactionCurrent !== "function" ||
    typeof methods.assertActive !== "function"
  )
    invalid();
  const assertActive = methods.assertActive.bind(input);
  return Object.freeze({
    preflight: Object.freeze({
      assertCurrent: methods.assertCurrent.bind(input),
      assertActive,
    }),
    transaction: Object.freeze({
      assertCurrent: methods.assertTransactionCurrent.bind(input),
      assertActive,
    }),
  });
}

/** Capture trusted callbacks without evaluating accessors or mutating the caller. */
export function captureCreativeProjectCommitAuthority(
  options: CreativeProjectCommitOptions | undefined,
  mode: Readonly<{
    allowTextUiTransaction: boolean;
    allowPlanTransaction?: boolean;
    allowOutlineUiTransaction?: boolean;
  }> = {
    allowTextUiTransaction: false,
  },
): CreativeProjectCommitAuthority | undefined {
  if (options === undefined) return undefined;
  const fields = ownDataFields(options, ["authority"]);
  const authority = fields.authority;
  if (authority === undefined) return undefined;
  const methods = ownDataFields(authority, [
    "assertCurrent",
    "assertActive",
    "transaction",
    "runTransaction",
    "textUiTransaction",
    "planTransaction",
    "outlineUiTransaction",
  ]);
  if (
    typeof methods.assertCurrent !== "function" ||
    typeof methods.assertActive !== "function"
  )
    invalid();
  if (
    [
      methods.transaction,
      methods.runTransaction,
      methods.textUiTransaction,
      methods.planTransaction,
      methods.outlineUiTransaction,
    ].filter((value) => value !== undefined).length > 1 ||
    (methods.textUiTransaction !== undefined && !mode.allowTextUiTransaction) ||
    (methods.planTransaction !== undefined &&
      mode.allowPlanTransaction !== true) ||
    (methods.outlineUiTransaction !== undefined &&
      mode.allowOutlineUiTransaction !== true)
  )
    invalid();
  return Object.freeze({
    assertCurrent: methods.assertCurrent.bind(authority),
    assertActive: methods.assertActive.bind(authority),
    ...(methods.outlineUiTransaction === undefined
      ? {}
      : {
          outlineUiTransaction: captureProjectOutlineUiCommitTransaction(
            methods.outlineUiTransaction,
          ),
        }),
    ...(methods.planTransaction === undefined
      ? {}
      : {
          planTransaction: captureProjectTextPlanSelectionCommitAuthority(
            methods.planTransaction,
          ),
        }),
    ...(methods.textUiTransaction === undefined
      ? {}
      : {
          textUiTransaction: captureProjectTextUiCommitTransaction(
            methods.textUiTransaction,
          ),
        }),
    ...(methods.transaction === undefined
      ? {}
      : { transaction: capturePluginTransaction(methods.transaction) }),
    ...(methods.runTransaction === undefined
      ? {}
      : {
          runTransaction: captureCreativeProjectRunCommitTransaction(
            methods.runTransaction,
          ),
        }),
  });
}

function capturePluginTransaction(
  input: unknown,
): CreativeProjectPluginCommitTransactionAuthority {
  const fields = ownDataFields(input, [
    "version",
    "pin",
    "selection",
    "package",
    "assertCurrent",
  ]);
  if (
    fields.version !== "crewon.creative-project-plugin-commit.v1" ||
    typeof fields.assertCurrent !== "function"
  )
    invalid();
  let pin: PluginTaskAdmissionPin;
  let selection: PluginSelection;
  let pkg: InstalledPluginPackage;
  try {
    pin = parsePluginTaskAdmissionPin(fields.pin);
    selection = parsePluginSelection(fields.selection);
    pkg = parseInstalledPluginPackage(fields.package);
  } catch {
    invalid();
  }
  if (
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
    version: "crewon.creative-project-plugin-commit.v1",
    pin,
    selection,
    package: pkg,
    assertCurrent: async () => {
      const result: unknown = await current();
      if (result !== undefined)
        throw new Error(
          "creative_project_commit_authority_async_result_invalid",
        );
    },
  });
}

/** The final local check must complete synchronously before COMMIT is dispatched. */
export function assertCreativeProjectCommitActive(
  authority: CreativeProjectCommitAuthority | undefined,
): void {
  if (authority === undefined) return;
  const result: unknown = authority.assertActive();
  if (result === undefined) return;
  // Observe an accidental native Promise rejection without reading or invoking a thenable's getter.
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
      // Arbitrary thenables are rejected without invoking their methods.
    }
  throw new Error("creative_project_commit_authority_sync_required");
}

/** Async policy revalidation is followed by a separate synchronous commit check. */
export async function assertCreativeProjectCommitCurrent(
  authority: CreativeProjectCommitAuthority | undefined,
): Promise<void> {
  if (authority === undefined) return;
  const result: unknown = await authority.assertCurrent();
  if (result !== undefined)
    throw new Error("creative_project_commit_authority_async_result_invalid");
}

/** The Store supplies installation checks on its own connection before invoking this external fence. */
export async function assertCreativeProjectCommitTransactionCurrent(
  authority: CreativeProjectCommitAuthority | undefined,
): Promise<void> {
  if (authority?.planTransaction !== undefined) {
    await authority.planTransaction.assertCurrent();
    return;
  }
  if (authority?.textUiTransaction !== undefined) {
    await authority.textUiTransaction.assertCurrent();
    return;
  }
  if (authority?.runTransaction !== undefined) {
    const result: unknown = await authority.runTransaction.assertCurrent();
    if (result !== undefined)
      throw new Error("creative_project_commit_authority_async_result_invalid");
    return;
  }
  if (authority?.transaction === undefined)
    return assertCreativeProjectCommitCurrent(authority);
  const result: unknown = await authority.transaction.assertCurrent();
  if (result !== undefined)
    throw new Error("creative_project_commit_authority_async_result_invalid");
}

function ownDataFields(input: unknown, allowed: readonly string[]) {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    invalid();
  const fields: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
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
  throw new Error("creative_project_commit_authority_invalid");
}
