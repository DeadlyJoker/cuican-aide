import { createHash } from "node:crypto";
import { canonicalJsonValue } from "@crewon/contracts/runtime";
import {
  ExtensionManifestError,
  extensionToolName,
  parseExtensionManifest,
  type ExtensionManifest,
} from "@crewon/domain";

export type ExtensionAdapterDescriptor = Readonly<{
  adapterId: string;
  implementationDigest: string;
  operationIds: readonly string[];
}>;

/** Supplied by reviewed host code; this registry never imports a path, URL or package name. */
export type BundledExtensionSource = Readonly<{
  sourceId: string;
  manifest: unknown;
  adapters: readonly ExtensionAdapterDescriptor[];
}>;

export type RegisteredExtension = Readonly<{
  manifest: ExtensionManifest;
  manifestDigest: string;
  implementationDigest: string;
  adapters: readonly ExtensionAdapterDescriptor[];
}>;

type Candidate = Readonly<{
  sourceId: string;
  registration: RegisteredExtension;
}>;
export type ExtensionRegistrationFailure = Readonly<{
  sourceId: string;
  code: string;
}>;

/** Static metadata only: registered is not authorized, deployed, healthy, or executable. */
export function createExtensionRegistry(
  sources: readonly BundledExtensionSource[],
) {
  if (!Array.isArray(sources) || sources.length > 64)
    fail("extension_registry_limit");
  const failures: ExtensionRegistrationFailure[] = [];
  const candidates: Candidate[] = [];
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/u.test(source.sourceId) ||
      sourceIds.has(source.sourceId)
    )
      fail("extension_source_identity_invalid");
    sourceIds.add(source.sourceId);
  }
  for (const source of sources) {
    try {
      const manifest = parseExtensionManifest(source.manifest);
      const adapters = parseAdapters(source.adapters, manifest);
      candidates.push({
        sourceId: source.sourceId,
        registration: Object.freeze({
          manifest,
          manifestDigest: digest(manifest),
          implementationDigest: digest({
            schemaVersion: "crewon.extension-implementation.v0",
            manifest,
            adapters,
          }),
          adapters,
        }),
      });
    } catch (error) {
      failures.push(
        Object.freeze({
          sourceId: source.sourceId,
          code:
            error instanceof ExtensionManifestError
              ? error.code
              : "extension_registration_invalid",
        }),
      );
    }
  }
  const conflicts = conflictsFor(candidates);
  const byVersion = new Map<string, RegisteredExtension>();
  for (const { sourceId, registration } of candidates) {
    const conflict = conflicts.get(sourceId);
    if (conflict !== undefined)
      failures.push(Object.freeze({ sourceId, code: conflict }));
    else
      byVersion.set(
        key(registration.manifest.pluginId, registration.manifest.version),
        registration,
      );
  }
  const registrations = Object.freeze(
    [...byVersion.values()].sort((a, b) =>
      compare(
        key(a.manifest.pluginId, a.manifest.version),
        key(b.manifest.pluginId, b.manifest.version),
      ),
    ),
  );
  const diagnostics = Object.freeze(
    failures.sort((a, b) => compare(a.sourceId, b.sourceId)),
  );
  return Object.freeze({
    list: () => registrations,
    failures: () => diagnostics,
    require: (
      identity: Readonly<{
        pluginId: string;
        version: string;
        implementationDigest: string;
      }>,
    ) => {
      const registration = byVersion.get(
        key(identity.pluginId, identity.version),
      );
      if (registration === undefined) fail("extension_version_unavailable");
      if (registration.implementationDigest !== identity.implementationDigest)
        fail("extension_implementation_mismatch");
      return registration;
    },
  });
}

function parseAdapters(
  input: readonly ExtensionAdapterDescriptor[],
  manifest: ExtensionManifest,
) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 16)
    fail("extension_adapters_invalid");
  const ids = new Set<string>();
  const adapters = input
    .map((adapter) => {
      if (
        adapter === null ||
        typeof adapter !== "object" ||
        Object.keys(adapter).sort().join("\0") !==
          ["adapterId", "implementationDigest", "operationIds"]
            .sort()
            .join("\0") ||
        typeof adapter.adapterId !== "string" ||
        adapter.adapterId.length > 48 ||
        !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u.test(adapter.adapterId) ||
        typeof adapter.implementationDigest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(adapter.implementationDigest) ||
        !Array.isArray(adapter.operationIds) ||
        adapter.operationIds.length < 1 ||
        adapter.operationIds.length > 32 ||
        adapter.operationIds.some(
          (id: unknown) =>
            typeof id !== "string" ||
            !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(id) ||
            id.length > 24,
        ) ||
        new Set(adapter.operationIds).size !== adapter.operationIds.length ||
        ids.has(adapter.adapterId)
      )
        fail("extension_adapters_invalid");
      ids.add(adapter.adapterId);
      return Object.freeze({
        adapterId: adapter.adapterId,
        implementationDigest: adapter.implementationDigest,
        operationIds: Object.freeze([...adapter.operationIds].sort(compare)),
      });
    })
    .sort((a, b) => compare(a.adapterId, b.adapterId));
  for (const tool of manifest.tools) {
    if (
      !adapters.some(
        (adapter) =>
          adapter.adapterId === tool.adapterId &&
          adapter.operationIds.includes(tool.operationId),
      )
    )
      fail("extension_adapter_operation_unavailable");
  }
  if (
    adapters.some(
      (adapter) =>
        !manifest.tools.some((tool) => tool.adapterId === adapter.adapterId),
    )
  )
    fail("extension_adapter_unused");
  return Object.freeze(adapters);
}

function conflictsFor(candidates: readonly Candidate[]) {
  const identities = new Map<string, Candidate[]>();
  const tools = new Map<string, Candidate[]>();
  const conflicts = new Map<string, string>();
  for (const candidate of candidates) {
    const manifest = candidate.registration.manifest;
    append(identities, key(manifest.pluginId, manifest.version), candidate);
    for (const tool of manifest.tools)
      append(
        tools,
        extensionToolName(manifest.pluginId, tool.operationId),
        candidate,
      );
  }
  for (const entries of identities.values())
    if (entries.length > 1)
      entries.forEach(({ sourceId }) =>
        conflicts.set(sourceId, "extension_version_duplicate"),
      );
  for (const entries of tools.values())
    if (
      new Set(entries.map(({ registration }) => registration.manifest.pluginId))
        .size > 1
    )
      entries.forEach(({ sourceId }) => {
        if (!conflicts.has(sourceId))
          conflicts.set(sourceId, "extension_tool_name_conflict");
      });
  return conflicts;
}

function append(
  map: Map<string, Candidate[]>,
  id: string,
  candidate: Candidate,
) {
  const items = map.get(id) ?? [];
  items.push(candidate);
  map.set(id, items);
}
function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJsonValue(value)).digest("hex")}`;
}
function key(pluginId: string, version: string): string {
  return JSON.stringify([pluginId, version]);
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function fail(code: string): never {
  throw new ExtensionManifestError(code);
}
