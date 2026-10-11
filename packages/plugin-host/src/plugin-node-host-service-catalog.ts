import { createHash } from "node:crypto";
import {
  createPluginCompositionLock,
  PLUGIN_COMPOSITION_LOCK_LIMITS,
  type PluginCompositionHostService,
} from "@crewon/contracts/plugins";
import type { PluginHostService } from "./plugin-host-service.ts";

export type PluginNodeHostServiceRegistration = Readonly<{
  metadata: PluginCompositionHostService;
  implementation: PluginHostService;
}>;
export type PluginNodeHostServiceCatalog = Readonly<{
  registrations: readonly PluginNodeHostServiceRegistration[];
  metadata: readonly PluginCompositionHostService[];
  implementations: readonly PluginHostService[];
}>;

export class PluginNodeHostServiceCatalogError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "PluginNodeHostServiceCatalogError";
    this.code = code;
  }
}

/**
 * Captures one trusted deployment's real Node implementations and their exact
 * composition identities together. Availability, plugin authorization and each
 * individual service call remain the actual owners' responsibility.
 *
 * A UI availability probe or a self-declared package dependency is not a Node
 * implementation and cannot be converted into one through this catalog.
 */
export function capturePluginNodeHostServiceCatalog(
  input: readonly PluginNodeHostServiceRegistration[],
): PluginNodeHostServiceCatalog {
  const entries = array(input).map((entry) => {
    const fields = record(entry, ["metadata", "implementation"]);
    return Object.freeze({
      metadata: fields.metadata as PluginCompositionHostService,
      implementation: captureImplementation(fields.implementation),
    });
  });
  const metadata = createPluginCompositionLock(
    {
      schemaVersion: "crewon.plugin-composition-lock.v1",
      scope: {
        tenantId: "host-service-catalog",
        spaceId: "host-service-catalog",
        profileId: "host-service-catalog",
        authorityEpoch: "host-service-catalog",
      },
      revision: 1,
      nodes: [],
      hostServices: entries.map((entry) => entry.metadata),
    },
    {
      sha256: (body: string) =>
        `sha256:${createHash("sha256").update(body).digest("hex")}`,
    },
  ).hostServices;
  const registrations = metadata.map((identity) => {
    const entry = entries.find(
      (value) =>
        value.implementation.service === identity.service &&
        value.implementation.apiVersion === identity.apiVersion,
    );
    // The contract parser rejects repeated metadata pairs. Require an exact
    // one-to-one match; a matching unrelated implementation cannot mask drift.
    if (
      entry === undefined ||
      entries.filter(
        (value) =>
          value.implementation.service === identity.service &&
          value.implementation.apiVersion === identity.apiVersion,
      ).length !== 1 ||
      entry.metadata.service !== identity.service ||
      entry.metadata.apiVersion !== identity.apiVersion
    )
      fail("plugin_host_service_catalog_identity_conflict");
    return Object.freeze({
      metadata: identity,
      implementation: entry.implementation,
    });
  });
  return Object.freeze({
    registrations: Object.freeze(registrations),
    metadata,
    implementations: Object.freeze(
      registrations.map((entry) => entry.implementation),
    ),
  });
}

function captureImplementation(input: unknown): PluginHostService {
  const fields = record(
    input,
    ["service", "apiVersion", "value", "bindForPlugin"],
    ["bindForPlugin"],
  );
  const { service, apiVersion, value, bindForPlugin } = fields;
  if (
    typeof service !== "string" ||
    typeof apiVersion !== "string" ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (bindForPlugin !== undefined && typeof bindForPlugin !== "function")
  )
    fail("plugin_host_service_catalog_implementation_invalid");
  return Object.freeze({
    service,
    apiVersion,
    value,
    ...(bindForPlugin === undefined
      ? {}
      : { bindForPlugin: bindForPlugin.bind(input) }),
  });
}

function record(
  input: unknown,
  allowed: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    fail("plugin_host_service_catalog_invalid");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    fail("plugin_host_service_catalog_invalid");
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.includes(key)) ||
    allowed.some((key) => !optional.includes(key) && !keys.includes(key))
  )
    fail("plugin_host_service_catalog_invalid");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(input, key)!;
    if (!field.enumerable || !("value" in field))
      fail("plugin_host_service_catalog_invalid");
    result[key as string] = field.value;
  }
  return result;
}

function array(input: unknown): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype)
    fail("plugin_host_service_catalog_invalid");
  const length = Object.getOwnPropertyDescriptor(input, "length");
  if (
    !length ||
    !("value" in length) ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0 ||
    length.value > PLUGIN_COMPOSITION_LOCK_LIMITS.hostServices ||
    Reflect.ownKeys(input).length !== length.value + 1
  )
    fail("plugin_host_service_catalog_invalid");
  const values: unknown[] = [];
  for (let index = 0; index < length.value; index++) {
    const field = Object.getOwnPropertyDescriptor(input, String(index));
    if (!field?.enumerable || !("value" in field))
      fail("plugin_host_service_catalog_invalid");
    values.push(field.value);
  }
  return values;
}

function fail(code: string): never {
  throw new PluginNodeHostServiceCatalogError(code);
}
