import { createHash, randomUUID } from "node:crypto";
import type {
  ActorContext,
  ExtensionCatalogPort,
  ExtensionHostPort,
  ExtensionReadiness,
  ExtensionRegistration,
  PluginQueryHostPort,
  PluginQuerySource,
} from "@crewon/application";
import { parseExtensionHostActor } from "@crewon/contracts";
import {
  INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
  parseInstalledPluginPeerRequest,
  parsePluginUiJsonValue,
  type InstalledPluginPeerIdentity,
  type InstalledPluginPeerRegistration,
  type InstalledPluginPeerResponse,
  type InstalledPluginPeerRequest,
  type InstalledPluginPeerExpectedSource,
} from "@crewon/contracts/plugins";
import {
  assertPluginTaskAdmission,
  extensionCanonicalJson,
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  parseExtensionManifest,
  parseExtensionRunBinding,
  parsePluginProfileScope,
  parsePluginTaskAdmission,
  validateExtensionConfiguration,
  type ExtensionConfiguration,
  type ExtensionExecutionTarget,
  type PluginProfileScope,
} from "@crewon/domain";
import {
  InstalledPluginPeerError,
  InstalledPluginPeerTransport,
  installedPeerOwnRecord,
  parseInstalledPluginPeerClientConfiguration,
  type InstalledPluginPeerClientConfiguration,
} from "./installed-plugin-peer-transport.ts";
export {
  InstalledPluginPeerError,
  parseInstalledPluginPeerClientConfiguration,
};
export type { InstalledPluginPeerClientConfiguration };
export type InstalledPluginPeerPrepared = Readonly<{
  catalog: ExtensionCatalogPort;
  host: ExtensionHostPort;
  pluginQueryHost: PluginQueryHostPort;
}>;
type RegistrationMetadata = Readonly<{
  identity: InstalledPluginPeerIdentity;
  configurations: readonly Readonly<{
    configuration: ExtensionConfiguration;
    target: ExtensionExecutionTarget;
  }>[];
}>;
const digester = Object.freeze({
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`,
});

/** Each immutable catalog belongs to one real actor/profile request, never a global latest selection. */
export class InstalledPluginPeerClient {
  readonly #transport: InstalledPluginPeerTransport;
  constructor(
    configuration: InstalledPluginPeerClientConfiguration,
    dependencies: Readonly<{ fetch?: typeof globalThis.fetch }> = {},
  ) {
    this.#transport = new InstalledPluginPeerTransport(
      configuration,
      dependencies,
    );
  }
  async prepare(
    input: Readonly<{ actor: ActorContext; scope: PluginProfileScope }>,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<InstalledPluginPeerPrepared> {
    this.#transport.assertOpen();
    const captured = installedPeerOwnRecord(input, ["actor", "scope"]);
    const actor = parseExtensionHostActor(captured.actor);
    const scope = parsePluginProfileScope(json(captured.scope));
    if (actor.tenantId !== scope.tenantId || actor.spaceId !== scope.spaceId)
      invalid("request");
    const optionsData = installedPeerOwnRecord(options, [], ["signal"]);
    const signal = optionsData.signal as AbortSignal | undefined;
    const base = Object.freeze({
      protocol: INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
      actor,
      scope,
    });
    const request = parseInstalledPluginPeerRequest({
      ...base,
      requestId: randomUUID(),
      operation: "catalog",
    });
    const response = await this.#transport.post(request, signal);
    if (response.operation !== "catalog") invalid("response");
    this.#transport.assertOpen();
    const metadata = new WeakMap<ExtensionRegistration, RegistrationMetadata>();
    const byVersion = new Map<string, ExtensionRegistration>();
    const historical = new Map<
      string,
      Readonly<{
        registration: ExtensionRegistration;
        metadata: RegistrationMetadata;
      }>
    >();
    try {
      for (const entry of response.entries) {
        const registration = parseRegistration(entry);
        const configuration = parseExtensionConfiguration(
          entry.configuration,
          digester,
        );
        const target = parseExtensionExecutionTarget(entry.configuredTarget);
        assertConfiguration(actor, registration, configuration);
        const key = registrationKey(registration);
        const existing = byVersion.get(key);
        const previous =
          existing === undefined ? undefined : metadata.get(existing);
        if (
          previous !== undefined &&
          (!same(previous.identity, entry.identity) ||
            !same(existing, registration))
        )
          invalid("response");
        metadata.set(
          existing ?? registration,
          Object.freeze({
            identity: entry.identity,
            configurations: Object.freeze([
              ...(previous?.configurations ?? []),
              Object.freeze({ configuration, target }),
            ]),
          }),
        );
        if (existing === undefined) byVersion.set(key, registration);
      }
    } catch {
      invalid("response");
    }
    const registrations = Object.freeze([...byVersion.values()]);
    const available = () => this.#transport.assertOpen();
    const capture = (raw: unknown) => {
      available();
      const fields = installedPeerOwnRecord(
        raw,
        ["actor", "registration", "configuration"],
        ["agentVersionId", "source", "expectedTarget"],
      );
      if (!same(parseExtensionHostActor(fields.actor), actor))
        invalid("request");
      const registration = canonicalRegistration(fields.registration);
      const current = byVersion.get(registrationKey(registration));
      const source =
        fields.source === undefined ? null : parseSource(fields.source);
      const candidates = [
        ...(current !== undefined && same(current, registration)
          ? [{ registration: current, metadata: metadata.get(current)! }]
          : []),
        ...[...historical.values()].filter((item) =>
          same(item.registration, registration),
        ),
      ].filter((item) =>
        source === null
          ? item.metadata.configurations.length > 0
          : matchesSourceIdentity(source, item.metadata.identity),
      );
      const unique = new Map(
        candidates.map((item) => [
          extensionCanonicalJson(item.metadata.identity),
          item.metadata,
        ]),
      );
      if (unique.size !== 1) invalid("request");
      const entry = [...unique.values()][0];
      if (entry === undefined) invalid("request");
      const configuration = parseExtensionConfiguration(
        json(fields.configuration),
        digester,
      );
      assertConfiguration(actor, registration, configuration);
      return { fields, registration, entry, configuration };
    };
    const post = (body: unknown): Promise<InstalledPluginPeerResponse> => {
      available();
      return this.#transport.post(
        parseInstalledPluginPeerRequest({
          ...base,
          requestId: randomUUID(),
          ...(body as object),
        }),
        signal,
      );
    };
    const queryInput = (raw: unknown) => {
      available();
      const fields = installedPeerOwnRecord(
        raw,
        ["actor", "source"],
        ["registration", "configuration", "expectedTarget"],
      );
      if (!same(parseExtensionHostActor(fields.actor), actor))
        invalid("request");
      const source = parseSource(fields.source);
      if (
        source.admission.tenantId !== scope.tenantId ||
        source.admission.spaceId !== scope.spaceId ||
        source.admission.profileId !== scope.profileId
      )
        invalid("request");
      return { fields, source, expectedSource: wireSource(source) };
    };
    const catalog: ExtensionCatalogPort = Object.freeze({
      list: () => {
        available();
        return registrations;
      },
      resolve: (
        identity: Readonly<{ pluginId: string; pluginVersion: string }>,
      ) => {
        available();
        // The original Application forwards the whole saved Configuration here.
        // This internal structural port reads only its two own identity fields;
        // every private wire request is still parsed with exact keys.
        const fields = catalogIdentity(identity);
        return (
          byVersion.get(
            JSON.stringify([fields.pluginId, fields.pluginVersion]),
          ) ?? null
        );
      },
    });
    const host: ExtensionHostPort = Object.freeze({
      taskAdmissionMode: (
        input: Readonly<{ registration: ExtensionRegistration }>,
      ) => {
        available();
        const registration = canonicalRegistration(
          installedPeerOwnRecord(input, ["registration"]).registration,
        );
        const current = byVersion.get(registrationKey(registration));
        if (
          !(current !== undefined && same(current, registration)) &&
          ![...historical.values()].some((item) =>
            same(item.registration, registration),
          )
        )
          invalid("request");
        return "installed" as const;
      },
      validateConfiguration: async (
        input: Parameters<ExtensionHostPort["validateConfiguration"]>[0],
      ) => {
        const { entry, configuration } = capture(input);
        const result = await post({
          operation: "validateConfiguration",
          identity: entry.identity,
          configuration,
        });
        if (result.operation !== "validateConfiguration") invalid("response");
        assertEcho(result, entry.identity, configuration);
      },
      evaluate: async (
        input: Parameters<ExtensionHostPort["evaluate"]>[0],
      ): Promise<ExtensionReadiness> => {
        const { fields, entry, configuration } = capture(input);
        const matches = entry.configurations.filter(
          (candidate) =>
            candidate.target.agentVersionId === fields.agentVersionId &&
            same(candidate.configuration, configuration),
        );
        if (matches.length !== 1) invalid("request");
        const expectedTarget = matches[0]!.target;
        const result = await post({
          operation: "readiness",
          identity: entry.identity,
          configuration,
          expectedTarget,
        });
        if (
          result.operation !== "readiness" ||
          !same(result.expectedTarget, expectedTarget)
        )
          invalid("response");
        assertEcho(result, entry.identity, configuration);
        return readiness(result.result, expectedTarget);
      },
    });
    const pluginQueryHost: PluginQueryHostPort = Object.freeze({
      resolveRegistration: async (
        input: Parameters<PluginQueryHostPort["resolveRegistration"]>[0],
      ) => {
        const { source, expectedSource } = queryInput(input);
        const result = await post({
          operation: "queryResolveRegistration",
          expectedSource,
        });
        if (
          result.operation !== "queryResolveRegistration" ||
          !same(result.expectedSource, expectedSource)
        )
          invalid("response");
        if (result.registration === null) return null;
        const registration = parseRegistration(result.registration);
        assertSourceIdentity(
          source,
          result.registration.identity,
          registration,
        );
        const key = extensionCanonicalJson(result.registration.identity);
        if (!historical.has(key) && historical.size >= 32) invalid("response");
        const value: RegistrationMetadata = Object.freeze({
          identity: result.registration.identity,
          configurations: Object.freeze([]),
        });
        const previous = historical.get(key);
        if (
          previous !== undefined &&
          !same(previous.registration, registration)
        )
          invalid("response");
        historical.set(key, Object.freeze({ registration, metadata: value }));
        metadata.set(registration, value);
        return registration;
      },
      evaluate: async (
        input: Parameters<PluginQueryHostPort["evaluate"]>[0],
      ): Promise<ExtensionReadiness> => {
        const { source, expectedSource } = queryInput(input);
        const { fields, registration, entry, configuration } = capture(input);
        assertSourceIdentity(source, entry.identity, registration);
        const expectedTarget = parseExtensionExecutionTarget(
          json(fields.expectedTarget),
        );
        if (
          !same(expectedTarget, source.binding.target) ||
          configuration.contentDigest !== source.binding.configurationDigest ||
          configuration.revision !== source.binding.configurationRevision
        )
          invalid("request");
        const result = await post({
          operation: "queryReadiness",
          expectedSource,
          identity: entry.identity,
          configuration,
          expectedTarget,
        });
        if (
          result.operation !== "queryReadiness" ||
          !same(result.expectedSource, expectedSource) ||
          !same(result.expectedTarget, expectedTarget)
        )
          invalid("response");
        assertEcho(result, entry.identity, configuration);
        return readiness(result.result, expectedTarget);
      },
    });
    return Object.freeze({ catalog, host, pluginQueryHost });
  }
  close(): Promise<void> {
    return this.#transport.close();
  }
}
function json(input: unknown) {
  return parsePluginUiJsonValue(input);
}
function parseRegistration(
  input: InstalledPluginPeerRegistration,
): ExtensionRegistration {
  const manifest = parseExtensionManifest(input.manifest);
  if (
    manifest.pluginId !== input.identity.pluginId ||
    manifest.version !== input.identity.version ||
    digester.sha256(extensionCanonicalJson(manifest)) !==
      input.identity.manifestDigest
  )
    invalid("response");
  return Object.freeze({
    manifest,
    manifestDigest: input.identity.manifestDigest,
    implementationDigest: input.identity.implementationDigest,
  });
}
function canonicalRegistration(input: unknown): ExtensionRegistration {
  const fields = installedPeerOwnRecord(json(input), [
    "manifest",
    "manifestDigest",
    "implementationDigest",
  ]);
  const manifest = parseExtensionManifest(fields.manifest);
  if (
    typeof fields.manifestDigest !== "string" ||
    fields.manifestDigest !==
      digester.sha256(extensionCanonicalJson(manifest)) ||
    typeof fields.implementationDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(fields.implementationDigest)
  )
    invalid("request");
  return Object.freeze({
    manifest,
    manifestDigest: fields.manifestDigest,
    implementationDigest: fields.implementationDigest,
  });
}
function catalogIdentity(
  input: unknown,
): Readonly<{ pluginId: string; pluginVersion: string }> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    invalid("request");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid("request");
  const pluginId = Object.getOwnPropertyDescriptor(input, "pluginId"),
    pluginVersion = Object.getOwnPropertyDescriptor(input, "pluginVersion");
  if (
    pluginId === undefined ||
    pluginVersion === undefined ||
    !("value" in pluginId) ||
    !("value" in pluginVersion) ||
    !pluginId.enumerable ||
    !pluginVersion.enumerable ||
    typeof pluginId.value !== "string" ||
    typeof pluginVersion.value !== "string"
  )
    invalid("request");
  return Object.freeze({
    pluginId: pluginId.value,
    pluginVersion: pluginVersion.value,
  });
}
function matchesSourceIdentity(
  source: PluginQuerySource,
  identity: InstalledPluginPeerIdentity,
): boolean {
  return (
    identity.pluginId === source.admission.pluginId &&
    identity.publisherId === source.admission.publisherId &&
    identity.version === source.admission.version &&
    identity.packageDigest === source.admission.packageDigest
  );
}
function assertConfiguration(
  actor: ActorContext,
  registration: ExtensionRegistration,
  configuration: ExtensionConfiguration,
): void {
  if (
    configuration.tenantId !== actor.tenantId ||
    configuration.spaceId !== actor.spaceId ||
    configuration.pluginId !== registration.manifest.pluginId ||
    configuration.pluginVersion !== registration.manifest.version ||
    configuration.manifestDigest !== registration.manifestDigest ||
    configuration.implementationDigest !== registration.implementationDigest
  )
    invalid("request");
  validateExtensionConfiguration(
    registration.manifest,
    configuration.parameters,
  );
}
function assertEcho(
  response: Readonly<{
    identity: InstalledPluginPeerIdentity;
    configurationDigest: string;
  }>,
  identity: InstalledPluginPeerIdentity,
  configuration: ExtensionConfiguration,
): void {
  if (
    !same(response.identity, identity) ||
    response.configurationDigest !== configuration.contentDigest
  )
    invalid("response");
}
function parseSource(input: unknown): PluginQuerySource {
  const fields = installedPeerOwnRecord(json(input), [
    "admission",
    "binding",
    "operationId",
  ]);
  const admission = parsePluginTaskAdmission(fields.admission);
  const binding = parseExtensionRunBinding(fields.binding, digester);
  assertPluginTaskAdmission(
    {
      admission,
      binding,
      receipt: {
        actorId: admission.actorId,
        idempotencyKey: admission.idempotencyKey,
        requestDigest: admission.requestDigest,
      },
    },
    digester,
  );
  if (
    typeof fields.operationId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(fields.operationId)
  )
    invalid("request");
  return Object.freeze({ admission, binding, operationId: fields.operationId });
}
function wireSource(
  source: PluginQuerySource,
): InstalledPluginPeerExpectedSource {
  // The contracts parser validates this bounded detached expectation; it never brands source authority.
  const request = parseInstalledPluginPeerRequest({
    protocol: INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
    requestId: randomUUID(),
    operation: "queryResolveRegistration",
    actor: {
      tenantId: source.admission.tenantId,
      spaceId: source.admission.spaceId,
      principalId: source.admission.principalId,
      actorId: source.admission.actorId,
    },
    scope: {
      tenantId: source.admission.tenantId,
      spaceId: source.admission.spaceId,
      profileId: source.admission.profileId,
    },
    expectedSource: source,
  });
  if (request.operation !== "queryResolveRegistration") invalid("request");
  return request.expectedSource;
}
function assertSourceIdentity(
  source: PluginQuerySource,
  identity: InstalledPluginPeerIdentity,
  registration: ExtensionRegistration,
): void {
  const admission = source.admission;
  if (
    identity.pluginId !== admission.pluginId ||
    identity.publisherId !== admission.publisherId ||
    identity.version !== admission.version ||
    identity.packageDigest !== admission.packageDigest ||
    identity.manifestDigest !== registration.manifestDigest ||
    identity.implementationDigest !== registration.implementationDigest
  )
    invalid("response");
}
function readiness(
  result: Extract<
    InstalledPluginPeerResponse,
    { operation: "readiness" }
  >["result"],
  target: ExtensionExecutionTarget,
): ExtensionReadiness {
  if (result.outcome === "unavailable") return result;
  const actual = parseExtensionExecutionTarget(result.target);
  if (!same(actual, target)) invalid("response");
  return Object.freeze({ outcome: "ready", target: actual });
}
function registrationKey(value: ExtensionRegistration): string {
  return JSON.stringify([value.manifest.pluginId, value.manifest.version]);
}
function same(left: unknown, right: unknown): boolean {
  return extensionCanonicalJson(left) === extensionCanonicalJson(right);
}
function invalid(kind: "request" | "response"): never {
  throw new InstalledPluginPeerError(`installed_plugin_peer_${kind}_invalid`);
}
