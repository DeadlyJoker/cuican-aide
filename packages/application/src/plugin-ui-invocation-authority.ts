import { ApplicationError } from "./application-error.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";

type Invocation = Readonly<{ assertCurrent: () => Promise<void> }>;
const invocations = new WeakMap<object, Invocation>();

/** Private service registration; this function is deliberately absent from the package entrypoint. */
export function registerPluginUiInvocation(
  context: PluginUiActionContext,
  assertCurrent: () => Promise<void>,
): () => void {
  if (
    context === null ||
    typeof context !== "object" ||
    typeof assertCurrent !== "function" ||
    invocations.has(context)
  )
    throw new ApplicationError(
      "internal",
      "plugin_ui_invocation_registration_invalid",
    );
  const invocation = Object.freeze({ assertCurrent });
  invocations.set(context, invocation);
  return () => {
    if (invocations.get(context) === invocation) invocations.delete(context);
  };
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
