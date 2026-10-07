import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  extensionCanonicalJson,
  parseExtensionConfiguration,
  pluginInstallationNamespaceId,
  projectAssetId,
  projectAssetDigest,
  projectAssetRevision,
  projectAssetTimestamp,
  projectAssetInputFields,
} from "@crewon/domain";
import {
  parseProjectReferenceMaterialFreezeRequest,
  parseFrozenProjectReferenceMaterial,
} from "./project-reference-material-freeze-record.ts";
import { projectAssetInstallationEvidence } from "./project-asset-qualification-data.ts";
import type {
  ProjectMaterialPreparationRequest,
  ProjectMaterialPreparationTarget,
  ProjectMaterialPreparationInitial,
  ProjectMaterialPreparationReservation,
  ProjectMaterialPreparationEvent,
} from "./project-material-preparation-port.ts";

export const MAX_PROJECT_MATERIAL_PREPARATION_BYTES = 96 * 1024;
export const materialPreparationDigester = Object.freeze({
  sha256: (text: string) =>
    `sha256:${createHash("sha256").update(text).digest("hex")}`,
});
export function materialPreparationFields(
  input: unknown,
  keys: readonly string[],
) {
  if (types.isProxy(input)) invalid();
  return projectAssetInputFields(input, keys);
}
const equal = (a: unknown, b: unknown) =>
  extensionCanonicalJson(a) === extensionCanonicalJson(b);
export function parseProjectMaterialPreparationRequest(
  input: unknown,
): ProjectMaterialPreparationRequest {
  const r = materialPreparationFields(materialPreparationData(input), [
      "source",
      "target",
      "idempotencyKey",
    ]),
    t = materialPreparationFields(r.target, [
      "profileId",
      "pluginId",
      "configurationRevision",
    ]);
  return Object.freeze({
    source: parseProjectReferenceMaterialFreezeRequest(r.source),
    target: Object.freeze({
      profileId: projectAssetId(t.profileId),
      pluginId: pluginInstallationNamespaceId(t.pluginId),
      configurationRevision: projectAssetRevision(t.configurationRevision),
    }),
    idempotencyKey: projectAssetId(r.idempotencyKey),
  });
}
export function projectMaterialPreparationIdentity(
  input: ProjectMaterialPreparationRequest,
) {
  const request = parseProjectMaterialPreparationRequest(input),
    actor = request.source.actor;
  return Object.freeze({
    intentId: `pmpr-${materialPreparationDigester.sha256(extensionCanonicalJson({ schemaVersion: "crewon.project-material-preparation.v1", actor, projectId: request.source.query.projectId, idempotencyKey: request.idempotencyKey })).slice(7)}`,
    requestDigest: materialPreparationDigester.sha256(
      extensionCanonicalJson(request),
    ),
  });
}
export function parseProjectMaterialPreparationTarget(
  input: unknown,
  request: ProjectMaterialPreparationRequest,
): ProjectMaterialPreparationTarget {
  const t = materialPreparationFields(materialPreparationData(input), [
    "installation",
    "selection",
    "package",
    "configuration",
  ]);
  const evidence = projectAssetInstallationEvidence({
    ...t,
    actor: request.source.actor,
  });
  const configuration = parseExtensionConfiguration(
    t.configuration,
    materialPreparationDigester,
  );
  if (
    evidence.installation.profileId !== request.target.profileId ||
    evidence.installation.pluginId !== request.target.pluginId ||
    configuration.tenantId !== evidence.installation.tenantId ||
    configuration.spaceId !== evidence.installation.spaceId ||
    configuration.pluginId !== evidence.installation.pluginId ||
    configuration.pluginVersion !== evidence.installation.version ||
    configuration.revision !== request.target.configurationRevision ||
    configuration.credentialBindings.length !== 0 ||
    configuration.pluginId !== "crewon.short-drama"
  )
    invalid();
  materialPreparationOrigin(configuration);
  return Object.freeze({
    installation: evidence.installation,
    selection: evidence.selection,
    package: evidence.package,
    configuration: freeze(configuration),
  });
}
export function materialPreparationOrigin(
  configuration: ProjectMaterialPreparationTarget["configuration"],
): string {
  if (typeof configuration.parameters.baseUrl !== "string") invalid();
  let url: URL;
  try {
    url = new URL(configuration.parameters.baseUrl);
  } catch {
    return invalid();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    invalid();
  return url.origin + "/";
}
export function createProjectMaterialPreparationInitial(
  input: ProjectMaterialPreparationReservation,
): ProjectMaterialPreparationInitial {
  const r = materialPreparationFields(materialPreparationData(input), [
      "request",
      "source",
      "target",
      "proposedTransfer",
      "at",
    ]),
    request = parseProjectMaterialPreparationRequest(r.request),
    source = parseFrozenProjectReferenceMaterial(
      r.source,
      materialPreparationDigester,
    ),
    target = parseProjectMaterialPreparationTarget(r.target, request),
    transfer = materialPreparationFields(r.proposedTransfer, [
      "preparationId",
      "requestDigest",
    ]);
  if (
    !equal(source.request, request.source) ||
    typeof transfer.preparationId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      transfer.preparationId,
    )
  )
    invalid();
  const body = {
    schemaVersion:
      source.schemaVersion === "crewon.project-reference-frozen-material.v1"
        ? ("crewon.project-material-preparation.v1" as const)
        : ("crewon.project-material-preparation.v2" as const),
    ...projectMaterialPreparationIdentity(request),
    request,
    source,
    target,
    transfer: Object.freeze({
      adapter: "comfyui-image-upload.v1" as const,
      preparationId: transfer.preparationId,
      origin: materialPreparationOrigin(target.configuration),
      output: Object.freeze({
        filename: `material-${source.source.byteDigest.slice(7)}.png`,
        subfolder: `crewon-materials/${transfer.preparationId}`,
        type: "output" as const,
      }),
      requestDigest: projectAssetDigest(transfer.requestDigest),
    }),
    createdAt: projectAssetTimestamp(r.at),
  };
  return parseProjectMaterialPreparationInitial({
    ...body,
    contentDigest: materialPreparationDigester.sha256(
      extensionCanonicalJson(body),
    ),
  });
}
export function parseProjectMaterialPreparationInitial(
  input: unknown,
): ProjectMaterialPreparationInitial {
  const r = materialPreparationFields(materialPreparationData(input), [
      "schemaVersion",
      "intentId",
      "requestDigest",
      "request",
      "source",
      "target",
      "transfer",
      "createdAt",
      "contentDigest",
    ]),
    t = materialPreparationFields(r.transfer, [
      "adapter",
      "preparationId",
      "origin",
      "output",
      "requestDigest",
    ]);
  if (
    (r.schemaVersion !== "crewon.project-material-preparation.v1" &&
      r.schemaVersion !== "crewon.project-material-preparation.v2") ||
    t.adapter !== "comfyui-image-upload.v1"
  )
    invalid();
  // The creation recipe validates all nested data and derives the only legal target path.
  const request = parseProjectMaterialPreparationRequest(r.request),
    source = parseFrozenProjectReferenceMaterial(
      r.source,
      materialPreparationDigester,
    ),
    target = parseProjectMaterialPreparationTarget(r.target, request);
  if (
    !equal(source.request, request.source) ||
    typeof t.preparationId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      t.preparationId,
    )
  )
    invalid();
  if (
    r.schemaVersion !==
    (source.schemaVersion === "crewon.project-reference-frozen-material.v1"
      ? "crewon.project-material-preparation.v1"
      : "crewon.project-material-preparation.v2")
  )
    invalid();
  const identity = projectMaterialPreparationIdentity(request),
    output = Object.freeze({
      filename: `material-${source.source.byteDigest.slice(7)}.png`,
      subfolder: `crewon-materials/${t.preparationId}`,
      type: "output" as const,
    }),
    origin = materialPreparationOrigin(target.configuration);
  if (
    r.intentId !== identity.intentId ||
    r.requestDigest !== identity.requestDigest ||
    t.origin !== origin ||
    !equal(
      materialPreparationFields(t.output, ["filename", "subfolder", "type"]),
      output,
    )
  )
    invalid();
  const body = {
    schemaVersion:
      source.schemaVersion === "crewon.project-reference-frozen-material.v1"
        ? ("crewon.project-material-preparation.v1" as const)
        : ("crewon.project-material-preparation.v2" as const),
    ...identity,
    request,
    source,
    target,
    transfer: Object.freeze({
      adapter: "comfyui-image-upload.v1" as const,
      preparationId: t.preparationId,
      origin,
      output,
      requestDigest: projectAssetDigest(t.requestDigest),
    }),
    createdAt: projectAssetTimestamp(r.createdAt),
  };
  const contentDigest = materialPreparationDigester.sha256(
    extensionCanonicalJson(body),
  );
  if (
    r.contentDigest !== contentDigest ||
    Buffer.byteLength(extensionCanonicalJson({ ...body, contentDigest })) >
      MAX_PROJECT_MATERIAL_PREPARATION_BYTES
  )
    invalid();
  return Object.freeze({ ...body, contentDigest });
}
export function parseProjectMaterialPreparationEvent(
  input: unknown,
  initial: ProjectMaterialPreparationInitial,
): ProjectMaterialPreparationEvent {
  const r = materialPreparationFields(materialPreparationData(input), [
      "intentId",
      "initialDigest",
      "revision",
      "phase",
      "observation",
      "failureCode",
      "at",
    ]),
    revision = projectAssetRevision(r.revision),
    at = projectAssetTimestamp(r.at);
  if (
    r.intentId !== initial.intentId ||
    r.initialDigest !== initial.contentDigest ||
    ![
      "reserved",
      "dispatching",
      "unknownOutcome",
      "verified",
      "rejected",
    ].includes(r.phase as string) ||
    at < initial.createdAt ||
    revision > 4 ||
    (revision === 1
      ? r.phase !== "reserved" || at !== initial.createdAt
      : r.phase === "reserved")
  )
    invalid();
  let observation: ProjectMaterialPreparationEvent["observation"] = null;
  if (r.phase === "verified") {
    const o = materialPreparationFields(r.observation, [
        "byteDigest",
        "byteLength",
        "width",
        "height",
        "checkedAt",
      ]),
      s = initial.source.source,
      checkedAt = projectAssetTimestamp(o.checkedAt);
    if (
      o.byteDigest !== s.byteDigest ||
      o.byteLength !== s.byteLength ||
      o.width !== s.width ||
      o.height !== s.height ||
      checkedAt < initial.createdAt ||
      checkedAt > at ||
      r.failureCode !== null
    )
      invalid();
    observation = Object.freeze({
      byteDigest: s.byteDigest,
      byteLength: s.byteLength,
      width: s.width,
      height: s.height,
      checkedAt,
    });
  } else if (r.observation !== null) invalid();
  const failureCode =
    r.failureCode === null ? null : projectAssetId(r.failureCode);
  if (
    r.phase === "unknownOutcome" || r.phase === "rejected"
      ? failureCode === null
      : failureCode !== null
  )
    invalid();
  return Object.freeze({
    intentId: initial.intentId,
    initialDigest: initial.contentDigest,
    revision,
    phase: r.phase as ProjectMaterialPreparationEvent["phase"],
    observation,
    failureCode,
    at,
  });
}
function freeze<T>(input: T): T {
  if (input !== null && typeof input === "object") {
    for (const v of Object.values(input)) freeze(v);
    Object.freeze(input);
  }
  return input;
}
/** Bounded descriptor copy before legacy JSON parsers; nested proxies/getters never execute. */
function materialPreparationData(input: unknown): unknown {
  let nodes = 0,
    textBytes = 0;
  const ancestors = new WeakSet<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 24576 || depth > 32) invalid();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      textBytes += Buffer.byteLength(value);
      if (textBytes > MAX_PROJECT_MATERIAL_PREPARATION_BYTES) invalid();
      return value;
    }
    if (
      typeof value !== "object" ||
      types.isProxy(value) ||
      ancestors.has(value)
    )
      invalid();
    const prototype = Object.getPrototypeOf(value),
      descriptors = Object.getOwnPropertyDescriptors(value),
      keys = Reflect.ownKeys(descriptors);
    if (
      Array.isArray(value)
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      invalid();
    if (
      keys.some((k) => typeof k !== "string") ||
      Object.values(descriptors).some((d) => !Object.hasOwn(d, "value"))
    )
      invalid();
    ancestors.add(value);
    let result: unknown;
    if (Array.isArray(value)) {
      const length = descriptors.length?.value;
      if (
        !Number.isSafeInteger(length) ||
        length > 8192 ||
        keys.length !== length + 1
      )
        invalid();
      result = Array.from({ length }, (_, i) => {
        const d = descriptors[String(i)];
        if (!d?.enumerable) invalid();
        return visit(d.value, depth + 1);
      });
    } else {
      if (
        keys.length > 256 ||
        Object.values(descriptors).some((d) => !d.enumerable)
      )
        invalid();
      result = Object.fromEntries(
        (keys as string[]).map((k) => [
          visit(k, depth + 1),
          visit(descriptors[k]!.value, depth + 1),
        ]),
      );
    }
    ancestors.delete(value);
    return result;
  };
  const copied = visit(input, 0);
  if (
    Buffer.byteLength(JSON.stringify(copied)) >
    MAX_PROJECT_MATERIAL_PREPARATION_BYTES
  )
    invalid();
  return copied;
}
function invalid(): never {
  throw new Error("project_material_preparation_record_invalid");
}
