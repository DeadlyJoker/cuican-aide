import {
  captureProjectAssetUiCommitTransaction,
  type ProjectAssetUiCommitTransactionAuthority,
} from "./project-asset-ui-commit-authority.ts";
import {
  captureProjectAssetRunCommitTransaction,
  type ProjectAssetRunCommitTransactionAuthority,
} from "./project-asset-run-commit-authority.ts";

/** Independent borrowed authority. No legacy text, plan, proposal or UI grant is accepted. */
export type ProjectAssetCommitAuthority = Readonly<{
  assertCurrent(): Promise<void>;
  /** External principal/profile/PDP/owner only; never borrows the archive's pool. */
  assertTransactionCurrent(): Promise<void>;
  assertActive(): void;
  uiTransaction?: ProjectAssetUiCommitTransactionAuthority;
  runTransaction?: ProjectAssetRunCommitTransactionAuthority;
}>;
export type ProjectAssetCommitOptions = Readonly<{
  authority?: ProjectAssetCommitAuthority;
}>;

function fields(input: unknown, allowed: readonly string[]) {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.includes(key)) invalid();
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (!field || !Object.hasOwn(field, "value") || !field.enumerable)
      invalid();
    result[key] = field.value;
  }
  return result;
}
function invalid(): never {
  throw new Error("project_asset_commit_authority_invalid");
}
export function captureProjectAssetCommitAuthority(
  options: ProjectAssetCommitOptions | undefined,
): ProjectAssetCommitAuthority | undefined {
  if (options === undefined) return undefined;
  const raw = fields(options, ["authority"]).authority;
  if (raw === undefined) return undefined;
  const value = fields(raw, [
    "assertCurrent",
    "assertTransactionCurrent",
    "assertActive",
    "uiTransaction",
    "runTransaction",
  ]);
  if (
    typeof value.assertCurrent !== "function" ||
    typeof value.assertTransactionCurrent !== "function" ||
    typeof value.assertActive !== "function" ||
    (value.uiTransaction !== undefined && value.runTransaction !== undefined)
  )
    invalid();
  return Object.freeze({
    assertCurrent: value.assertCurrent.bind(raw),
    assertTransactionCurrent: value.assertTransactionCurrent.bind(raw),
    assertActive: value.assertActive.bind(raw),
    ...(value.uiTransaction === undefined
      ? {}
      : {
          uiTransaction: captureProjectAssetUiCommitTransaction(
            value.uiTransaction,
          ),
        }),
    ...(value.runTransaction === undefined
      ? {}
      : {
          runTransaction: captureProjectAssetRunCommitTransaction(
            value.runTransaction,
          ),
        }),
  });
}
export async function assertProjectAssetCommitCurrent(
  authority: ProjectAssetCommitAuthority | undefined,
): Promise<void> {
  if (authority && (await authority.assertCurrent()) !== undefined) invalid();
  assertProjectAssetCommitActive(authority);
}
export async function assertProjectAssetCommitTransactionCurrent(
  authority: ProjectAssetCommitAuthority | undefined,
): Promise<void> {
  if (authority && (await authority.assertTransactionCurrent()) !== undefined)
    invalid();
  const q = authority?.uiTransaction ?? authority?.runTransaction;
  if (q && (await q.assertCurrent()) !== undefined) invalid();
  assertProjectAssetCommitActive(authority);
}
export function assertProjectAssetCommitActive(
  authority: ProjectAssetCommitAuthority | undefined,
): void {
  if (!authority) return;
  const result: unknown = authority.assertActive();
  if (result === undefined) return;
  try {
    void Promise.prototype.then.call(
      result,
      () => undefined,
      () => undefined,
    );
  } catch {
    /* Do not invoke arbitrary thenables. */
  }
  throw new Error("project_asset_commit_authority_sync_required");
}
