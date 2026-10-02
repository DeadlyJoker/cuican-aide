export class PluginInstallationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "PluginInstallationError";
    this.code = code;
  }
}

export function pluginInstallationFailure(code: string): never {
  throw new PluginInstallationError(code);
}

/** Flat persisted DTOs: bound keys and values without invoking accessors or serialization hooks. */
export function pluginInstallationRecord(
  input: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    pluginInstallationFailure("plugin_installation_object_invalid");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    pluginInstallationFailure("plugin_installation_object_invalid");
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    pluginInstallationFailure("plugin_installation_fields_invalid");
  return Object.freeze(
    Object.fromEntries(
      fields.map((field) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, field);
        if (
          !descriptor ||
          !Object.hasOwn(descriptor, "value") ||
          !descriptor.enumerable
        )
          pluginInstallationFailure("plugin_installation_fields_invalid");
        return [field, descriptor.value] as const;
      }),
    ),
  );
}

export function pluginInstallationOpaqueId(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 128 ||
    input.trim() !== input ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input)
  )
    pluginInstallationFailure("plugin_installation_identity_invalid");
  for (const point of input) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff)
      pluginInstallationFailure("plugin_installation_identity_invalid");
  }
  return input;
}

/** Matches the independent package protocol namespace syntax without importing Contracts. */
export function pluginInstallationNamespaceId(input: unknown): string {
  if (typeof input !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/u.test(input))
    pluginInstallationFailure("plugin_installation_namespace_invalid");
  return input;
}

export function pluginInstallationVersion(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length > 128 ||
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
      input,
    )
  )
    pluginInstallationFailure("plugin_installation_version_invalid");
  return input;
}

export function pluginInstallationDigest(input: unknown): string {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input))
    pluginInstallationFailure("plugin_installation_digest_invalid");
  return input;
}

export function pluginInstallationTimestamp(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length !== 24 ||
    !Number.isFinite(Date.parse(input)) ||
    new Date(input).toISOString() !== input
  )
    pluginInstallationFailure("plugin_installation_timestamp_invalid");
  return input;
}

export function pluginInstallationRevision(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1)
    pluginInstallationFailure("plugin_installation_revision_invalid");
  return input;
}

export function pluginInstallationNextRevision(input: number): number {
  const current = pluginInstallationRevision(input);
  if (current === Number.MAX_SAFE_INTEGER)
    pluginInstallationFailure("plugin_installation_revision_exhausted");
  return current + 1;
}
