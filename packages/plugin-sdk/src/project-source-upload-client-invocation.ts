import { fail } from "./definition-validation.js";
import type { PluginProjectSourceUploadInvocationOptions } from "./project-source-uploads.types.js";

const nativeAborted = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)!.get!;

export function sourceUploadSignal(
  options: PluginProjectSourceUploadInvocationOptions,
): AbortSignal | undefined {
  const value = sourceUploadClientRecord(options, ["signal"]);
  if (value.signal === undefined) return undefined;
  try {
    nativeAborted.call(value.signal);
  } catch {
    fail("plugin_ui_invocation_options_invalid");
  }
  active(value.signal as AbortSignal);
  return value.signal as AbortSignal;
}

export function sourceUploadClientRecord(
  input: unknown,
  allowed: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    fail("plugin_ui_invocation_options_invalid");
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key)))
    fail("plugin_ui_invocation_options_invalid");
  return Object.freeze(
    Object.fromEntries(
      keys.map((key) => {
        const own = Object.getOwnPropertyDescriptor(input, key);
        if (!own?.enumerable || !("value" in own))
          fail("plugin_ui_invocation_options_invalid");
        return [key, own.value];
      }),
    ),
  );
}

export function captureSourceUploadClientMethod<Method>(
  input: unknown,
  name: string,
): Method {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    fail("plugin_ui_invocation_service_invalid");
  const own = Object.getOwnPropertyDescriptor(input, name);
  if (!own?.enumerable || !("value" in own) || typeof own.value !== "function")
    fail("plugin_ui_invocation_service_invalid");
  return Function.prototype.bind.call(own.value, input) as Method;
}

function active(signal: AbortSignal | undefined): void {
  if (signal !== undefined && nativeAborted.call(signal))
    throw (
      signal.reason ??
      new DOMException("The operation was aborted", "AbortError")
    );
}

/** Logical cancellation observes late native completion; it never retries the invocation. */
export async function invokeSourceUploadClient<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<unknown>,
  parse: (output: unknown) => T,
): Promise<T> {
  active(signal);
  let rejectAborted: ((reason: unknown) => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    rejectAborted = reject;
  });
  const onAbort = () =>
    rejectAborted?.(
      signal?.reason ??
        new DOMException("The operation was aborted", "AbortError"),
    );
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    active(signal);
    const pending = Promise.resolve().then(() => {
      active(signal);
      return operation();
    });
    const output = await Promise.race([pending, cancelled]);
    active(signal);
    const parsed = parse(output);
    active(signal);
    return parsed;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    rejectAborted = undefined;
  }
}
