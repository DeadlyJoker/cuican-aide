import { InstalledPluginRunContextError } from "./installed-plugin-run-context-error.ts";
function fail(code: string): never {
  throw new InstalledPluginRunContextError(code);
}
/** Compatibility re-export of the original shared receipt/Run validator. No authority is issued here. */
export {
  assertPluginTaskRunReceipt as validateReceipt,
  assertPluginTaskRunSnapshot as assertRun,
} from "@crewon/application";

export function record(
  input: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null) ||
    Reflect.ownKeys(input).length !== fields.length
  )
    fail("installed_plugin_context_fields_invalid");
  return Object.freeze(
    Object.fromEntries(
      fields.map((field) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, field);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
          fail("installed_plugin_context_fields_invalid");
        return [field, descriptor.value];
      }),
    ),
  );
}
export function checkedPurpose(input: unknown): "submit" | "observe" {
  if (input !== "submit" && input !== "observe")
    fail("installed_plugin_context_purpose_invalid");
  return input;
}
export function checkedSignal(input: unknown): AbortSignal {
  if (!(input instanceof AbortSignal))
    fail("installed_plugin_context_signal_invalid");
  input.throwIfAborted();
  return input;
}
