import type {
  CreativeProjectCommitAuthority,
  CreativeProjectCommitOptions,
} from "./creative-project-store-port.ts";

/** Capture trusted callbacks without evaluating accessors or mutating the caller. */
export function captureCreativeProjectCommitAuthority(
  options: CreativeProjectCommitOptions | undefined,
): CreativeProjectCommitAuthority | undefined {
  if (options === undefined) return undefined;
  const fields = ownDataFields(options, ["authority"]);
  const authority = fields.authority;
  if (authority === undefined) return undefined;
  const methods = ownDataFields(authority, ["assertCurrent", "assertActive"]);
  if (
    typeof methods.assertCurrent !== "function" ||
    typeof methods.assertActive !== "function"
  )
    invalid();
  return Object.freeze({
    assertCurrent: methods.assertCurrent.bind(authority),
    assertActive: methods.assertActive.bind(authority),
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
