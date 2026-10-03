import { ApplicationError } from "./application-error.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";

export type PluginUiInvocationCommitAuthority = Readonly<{
  assertCurrent(): Promise<void>;
  assertActive(): void;
}>;

type Invocation = Readonly<{
  assertCurrent: () => Promise<void>;
  assertActive?: () => void;
}>;
const invocations = new WeakMap<object, Invocation>();

/** Private service registration; this function is deliberately absent from the package entrypoint. */
export function registerPluginUiInvocation(
  context: PluginUiActionContext,
  assertCurrent: () => Promise<void>,
  assertActive?: () => void,
): () => void {
  if (
    context === null ||
    typeof context !== "object" ||
    typeof assertCurrent !== "function" ||
    (assertActive !== undefined && typeof assertActive !== "function") ||
    invocations.has(context)
  )
    throw new ApplicationError(
      "internal",
      "plugin_ui_invocation_registration_invalid",
    );
  const invocation = Object.freeze({ assertCurrent, assertActive });
  invocations.set(context, invocation);
  return () => {
    if (invocations.get(context) === invocation) invocations.delete(context);
  };
}

/** Trusted Host-only capability for an actual registered invocation; not a JSON permission. */
export function capturePluginUiInvocationCommitAuthority(
  context: PluginUiActionContext,
): PluginUiInvocationCommitAuthority {
  const invocation =
    context !== null && typeof context === "object"
      ? invocations.get(context)
      : undefined;
  if (invocation?.assertActive === undefined)
    throw new ApplicationError(
      "authorization",
      "plugin_ui_invocation_unavailable",
    );
  const assertActive = () => {
    if (invocations.get(context) !== invocation)
      throw new ApplicationError(
        "authorization",
        "plugin_ui_invocation_unavailable",
      );
    const result: unknown = invocation.assertActive!();
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
          // Arbitrary thenables remain unread and cannot defer the synchronous fence.
        }
      throw new ApplicationError(
        "authorization",
        "plugin_ui_invocation_active_check_invalid",
      );
    }
    if (invocations.get(context) !== invocation)
      throw new ApplicationError(
        "authorization",
        "plugin_ui_invocation_unavailable",
      );
  };
  assertActive();
  return Object.freeze({
    assertActive,
    assertCurrent: async () => {
      assertActive();
      await assertPluginUiInvocationCurrent(context);
      assertActive();
    },
  });
}

/** Host bridge commit fence for this exact live UI invocation, including actual closeMount disposal. */
export async function assertPluginUiInvocationCurrent(
  context: PluginUiActionContext,
): Promise<void> {
  const invocation =
    context !== null && typeof context === "object"
      ? invocations.get(context)
      : undefined;
  if (invocation === undefined)
    throw new ApplicationError(
      "authorization",
      "plugin_ui_invocation_unavailable",
    );
  try {
    await invocation.assertCurrent();
  } catch (error) {
    // An action deny withdraws this invocation, while independent mount/asset permissions retain their original semantics.
    if (
      error instanceof ApplicationError &&
      error.code === "plugin_ui_authorization_denied" &&
      invocations.get(context) === invocation
    )
      invocations.delete(context);
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(
      "authorization",
      "plugin_ui_invocation_unavailable",
      { cause: error },
    );
  }
  // A callback that started while active cannot retain authority after its invocation has ended.
  if (invocations.get(context) !== invocation)
    throw new ApplicationError(
      "authorization",
      "plugin_ui_invocation_unavailable",
    );
}
