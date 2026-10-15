import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import {
  parsePluginProfileScope,
  parsePluginTaskAdmission,
  parsePluginTaskAdmissionPin,
  parsePluginTaskUnmeteredAuthorization,
} from "@crewon/domain";
import type {
  PimControlActor,
  PimControlSessions,
} from "./pim-control-sessions.ts";

type Scope = ReturnType<typeof parsePluginProfileScope>;
type Identity = Readonly<{
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
}>;
const services = [
  "project-tools",
  "foundation-tools",
  "outline-tools",
  "asset-tools",
] as const;
type Grant = Readonly<{
  scope: Scope;
  identity: Identity;
  services: readonly (typeof services)[number][];
  unmetered: ReturnType<typeof parsePluginTaskUnmeteredAuthorization> | null;
}>;
/** Separate operator approval. Installing or rendering a package never grants execution or free usage. */
export function readPimPluginExecutionGrants(raw: string): readonly Grant[] {
  try {
    if (Buffer.byteLength(raw) > 32768) invalid();
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values) || values.length > 32) invalid();
    const keys = new Set<string>();
    return Object.freeze(
      values.map((value) => {
        const v = record(value, ["scope", "identity", "services", "unmetered"]),
          scope = parsePluginProfileScope(v.scope),
          packageIdentity = identity(v.identity);
        if (
          !Array.isArray(v.services) ||
          v.services.some((s) => !services.includes(s)) ||
          new Set(v.services).size !== v.services.length
        )
          invalid();
        const key = JSON.stringify([
          scope.tenantId,
          scope.spaceId,
          scope.profileId,
          packageIdentity,
        ]);
        if (keys.has(key)) invalid();
        keys.add(key);
        return Object.freeze({
          scope,
          identity: packageIdentity,
          services: Object.freeze([...v.services]),
          unmetered:
            v.unmetered === null
              ? null
              : parsePluginTaskUnmeteredAuthorization(v.unmetered),
        }) as Grant;
      }),
    );
  } catch {
    throw new Error("pim_plugin_execution_grants_invalid");
  }
}
export function createPimPluginExecutionAuthority(
  sessions: PimControlSessions,
  grants: readonly Grant[],
) {
  const find = (scope: Scope, pkg: Identity) =>
    grants.find(
      (g) => sameScope(g.scope, scope) && sameIdentity(g.identity, pkg),
    );
  async function checkedPin(
    value: unknown,
    signal: AbortSignal,
    admitted: boolean,
  ) {
    const pin = admitted
      ? parsePluginTaskAdmission(value)
      : parsePluginTaskAdmissionPin(value);
    const grant = find(
      parsePluginProfileScope({
        tenantId: pin.tenantId,
        spaceId: pin.spaceId,
        profileId: pin.profileId,
      }),
      pin,
    );
    if (
      !grant ||
      pin.action !== "project.execute" ||
      pin.contributionId !== "workbench"
    )
      return null;
    const actor = {
      tenantId: pin.tenantId,
      spaceId: pin.spaceId,
      actorId: pin.actorId,
      principalId: pin.principalId,
    };
    const decision = await sessions.pluginPolicy(
      {
        actor,
        action: "pluginUi:invoke",
        resource: {
          kind: "pluginUi",
          ...grant.scope,
          pluginId: pin.pluginId,
          packageDigest: pin.packageDigest,
        },
      },
      signal,
    );
    if (
      decision.outcome !== "allow" ||
      decision.authorityEpoch !== pin.authorityEpoch
    )
      return null;
    signal.throwIfAborted();
    return { pin, grant, actor };
  }
  return Object.freeze({
    async handle(
      operation: string,
      body: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<unknown> {
      if (operation === "execution-actor") {
        record(body, ["schemaVersion", "owner"]);
        if (body.schemaVersion !== "crewon.plugin-execution-actor.v1")
          invalid();
        const owner = record(body.owner, ["tenantId", "spaceId", "actorId"]);
        Object.values(owner).forEach(id);
        return sessions.executionActor(
          owner as Pick<PimControlActor, "tenantId" | "spaceId" | "actorId">,
          signal,
        );
      }
      if (operation === "execution-package") {
        record(body, ["schemaVersion", "identity", "scope", "purpose"]);
        if (
          body.schemaVersion !== "crewon.plugin-execution-package.v1" ||
          !["read", "submit", "observe"].includes(String(body.purpose))
        )
          invalid();
        const scope = parsePluginProfileScope(body.scope),
          pkg = identity(body.identity),
          grant = find(scope, pkg);
        if (!grant) return { outcome: "deny" };
        // Deployment metadata is OS/operator authority, independent of a logged-in browser.
        // Run submission and observation below still require a current enterprise account.
        if (body.purpose === "read") return { outcome: "allow" };
        const current = await sessions.executionProfile(scope, signal);
        const decision = await sessions.pluginPolicy(
          {
            actor: current.actor,
            action:
              body.purpose === "read" ? "pluginUi:asset" : "pluginUi:invoke",
            resource: {
              kind: "pluginUi",
              ...scope,
              pluginId: pkg.pluginId,
              packageDigest: pkg.packageDigest,
            },
          },
          signal,
        );
        return { outcome: decision.outcome };
      }
      if (operation === "task-unmetered-policy") {
        record(body, ["schemaVersion", "actor", "pin"]);
        if (body.schemaVersion !== "crewon.plugin-task-unmetered-policy.v1")
          invalid();
        const actor = checkedActor(body.actor),
          checked = await checkedPin(body.pin, signal, false);
        if (
          !checked ||
          !sameActor(actor, checked.actor) ||
          !checked.grant.unmetered
        )
          return { outcome: "deny", authorization: null };
        return { outcome: "allow", authorization: checked.grant.unmetered };
      }
      if (operation !== "project-service-policy") invalid();
      if (body.kind === "permission") {
        record(body, ["schemaVersion", "kind", "permission"]);
        if (body.schemaVersion !== "crewon.plugin-project-service-policy.v1")
          invalid();
        const p = record(body.permission, ["actor", "action", "resource"]),
          actor = checkedActor(p.actor),
          r = record(p.resource, ["kind", "tenantId", "spaceId", "projectId"]);
        if (
          r.kind !== "creativeProject" ||
          ![
            "creativeProject:list",
            "creativeProject:create",
            "creativeProject:read",
            "creativeProject:write",
          ].includes(String(p.action))
        )
          invalid();
        for (const k of ["tenantId", "spaceId"]) id(r[k]);
        if (r.projectId !== null) id(r.projectId);
        const result = await sessions.controlPolicy(
          { actor, action: p.action as string, resource: r },
          signal,
        );
        return { outcome: result.outcome };
      }
      record(body, ["schemaVersion", "kind", "service", "admission"]);
      if (
        body.schemaVersion !== "crewon.plugin-project-service-policy.v1" ||
        body.kind !== "service" ||
        !services.includes(body.service as (typeof services)[number])
      )
        invalid();
      const checked = await checkedPin(body.admission, signal, true);
      return {
        outcome:
          checked &&
          checked.grant.services.includes(
            body.service as (typeof services)[number],
          )
            ? "allow"
            : "deny",
      };
    },
  });
}
function identity(raw: unknown): Identity {
  const v = record(raw, [
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
  ]);
  for (const k of ["pluginId", "publisherId", "version"]) id(v[k]);
  if (
    typeof v.packageDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(v.packageDigest)
  )
    invalid();
  return Object.freeze({
    pluginId: v.pluginId,
    publisherId: v.publisherId,
    version: v.version,
    packageDigest: v.packageDigest,
  }) as Identity;
}
function checkedActor(raw: unknown): PimControlActor {
  const v = record(raw, ["tenantId", "spaceId", "principalId", "actorId"]);
  Object.values(v).forEach(id);
  return v as PimControlActor;
}
function record(value: unknown, keys: readonly string[]) {
  try {
    const result = parsePluginUiJsonValue(value, { maxBytes: 32768 });
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      Object.keys(result).sort().join("\0") !== [...keys].sort().join("\0")
    )
      invalid();
    return result as Record<string, unknown>;
  } catch {
    return invalid();
  }
}
function id(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(value)
  )
    invalid();
}
function sameScope(a: Scope, b: Scope) {
  return (
    a.tenantId === b.tenantId &&
    a.spaceId === b.spaceId &&
    a.profileId === b.profileId
  );
}
function sameIdentity(a: Identity, b: Identity) {
  return (
    a.pluginId === b.pluginId &&
    a.publisherId === b.publisherId &&
    a.version === b.version &&
    a.packageDigest === b.packageDigest
  );
}
function sameActor(a: PimControlActor, b: PimControlActor) {
  return (
    a.tenantId === b.tenantId &&
    a.spaceId === b.spaceId &&
    a.actorId === b.actorId &&
    a.principalId === b.principalId
  );
}
function invalid(): never {
  throw new Error("pim_authority_request_invalid");
}
