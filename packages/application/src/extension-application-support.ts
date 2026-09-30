import {
  ExtensionManifestError,
  extensionCanonicalJson,
  extensionDigest,
  extensionOpaqueId,
  parseExtensionManifest,
  parseExtensionScope,
  type ExtensionScope,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type {
  ActorContext,
  AuthorizationPort,
  ExtensionAuthorizationAction,
} from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type {
  ExtensionCatalogPort,
  ExtensionRegistration,
} from "./extension-host-port.ts";

/** Copy before any await so callers cannot change an authorized command in flight. */
export function extensionCommand(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  const value: unknown = JSON.parse(extensionCanonicalJson(input));
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")
  )
    throw new ApplicationError("validation", "extension_command_invalid");
  return value as Record<string, unknown>;
}

export function extensionActor(input: ActorContext): ActorContext {
  const value = extensionCommand(input, [
    "principalId",
    "actorId",
    "tenantId",
    "spaceId",
  ]);
  return Object.freeze({
    principalId: extensionOpaqueId(value.principalId),
    actorId: extensionOpaqueId(value.actorId),
    tenantId: extensionOpaqueId(value.tenantId),
    spaceId: extensionOpaqueId(value.spaceId),
  });
}

export function extensionScopeFor(
  actor: ActorContext,
  pluginId: string,
): ExtensionScope {
  return Object.freeze(
    parseExtensionScope({
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      pluginId,
    }),
  );
}

export async function authorizeExtension(
  authorization: AuthorizationPort,
  actor: ActorContext,
  action: ExtensionAuthorizationAction,
  scope: ExtensionScope,
): Promise<void> {
  try {
    const decision = await authorization.authorize({
      actor,
      action,
      resource: { kind: "extension", ...scope },
    });
    if (decision.outcome !== "allow")
      throw new ApplicationError("authorization", "authorization_denied");
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError("authorization", "authorization_unavailable", {
      cause: error,
    });
  }
}

export function requireExtensionRegistration(
  catalog: ExtensionCatalogPort,
  digester: ContentDigester,
  identity: { pluginId: string; pluginVersion: string },
): ExtensionRegistration {
  const registration = catalog.resolve(identity);
  if (registration === null)
    throw new ApplicationError("notFound", "extension_version_unavailable");
  try {
    const manifest = parseExtensionManifest(registration.manifest);
    extensionDigest(registration.manifestDigest);
    extensionDigest(registration.implementationDigest);
    if (
      manifest.pluginId !== identity.pluginId ||
      manifest.version !== identity.pluginVersion ||
      digester.sha256(extensionCanonicalJson(manifest)) !==
        registration.manifestDigest
    )
      throw new Error("extension_catalog_identity_mismatch");
    return Object.freeze({
      manifest,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
    });
  } catch (error) {
    throw new ApplicationError("internal", "extension_catalog_invalid", {
      cause: error,
    });
  }
}

export async function extensionUseCase<T>(
  execute: () => Promise<T>,
): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    if (error instanceof ExtensionManifestError)
      throw new ApplicationError("validation", error.code, { cause: error });
    const code = error instanceof Error ? error.message : "";
    if (
      [
        "extension_idempotency_conflict",
        "extension_configuration_revision_conflict",
        "extension_activation_revision_conflict",
        "extension_execution_target_not_deployed",
      ].includes(code)
    )
      throw new ApplicationError("conflict", code, { cause: error });
    if (code === "extension_configuration_not_found")
      throw new ApplicationError("notFound", code, { cause: error });
    throw new ApplicationError("internal", "extension_service_unavailable", {
      cause: error,
    });
  }
}
