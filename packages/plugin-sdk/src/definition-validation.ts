/** Shape validation only. A trusted ABI wrapper is not a code sandbox or a permission grant. */
export class PluginSdkContractError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "PluginSdkContractError";
    this.code = code;
  }
}

export function definitionFields(
  input: unknown,
  expected: readonly string[],
): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    fail("plugin_definition_object_invalid");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    fail("plugin_definition_object_invalid");
  const names = Reflect.ownKeys(input);
  if (
    names.length !== expected.length ||
    names.some((name) => typeof name !== "string" || !expected.includes(name))
  )
    fail("plugin_definition_fields_invalid");
  const entries = expected.map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      fail("plugin_definition_fields_invalid");
    return [name, descriptor.value] as const;
  });
  return Object.freeze(Object.fromEntries(entries));
}
export function definitionPluginId(input: unknown): string {
  if (typeof input !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/u.test(input))
    fail("plugin_definition_id_invalid");
  return input;
}
export function fail(code: string): never {
  throw new PluginSdkContractError(code);
}
