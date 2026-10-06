import {
  createProjectMaterialPreparationInitial,
  parseProjectMaterialPreparationInitial,
  parseProjectMaterialPreparationEvent,
  parseProjectMaterialPreparationRequest,
  projectMaterialPreparationIdentity,
  frozenProjectMaterialFingerprint,
  materialPreparationFields,
  type ProjectMaterialPreparationStore,
  type ProjectMaterialPreparationState,
  type ProjectMaterialPreparationInitial,
  type ProjectMaterialPreparationEvent,
  type ProjectMaterialPreparationRequest,
  type ProjectGenerationImageResultVerifier,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parseExtensionConfiguration,
  projectAssetRevision,
  projectAssetTimestamp,
  projectAssetDigest,
  projectAssetId,
} from "@crewon/domain";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import { loadAssetReferenceImagePlan } from "./project-asset-reference-image-plan.ts";
import {
  assetQuery,
  assetLock,
  assetProject,
  assetOwner,
  type AssetSql,
  type AssetRows,
  type AssetDialect,
} from "./project-asset-store-support.ts";

export type MaterialPreparationInstruction =
  | AssetSql
  | Readonly<{ installation: ProjectMaterialPreparationInitial["target"] }>;
export type MaterialPreparationPlan<T> = Generator<
  MaterialPreparationInstruction,
  T,
  AssetRows
>;
type Input<K extends keyof ProjectMaterialPreparationStore> = Parameters<
  ProjectMaterialPreparationStore[K]
>[0];
const same = (a: unknown, b: unknown) =>
  extensionCanonicalJson(a) === extensionCanonicalJson(b);
const record = (raw: unknown) =>
  typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
const allowed = (a: string, b: string) =>
  a === "reserved"
    ? b === "dispatching"
    : a === "dispatching"
      ? ["unknownOutcome", "verified", "rejected"].includes(b)
      : a === "unknownOutcome"
        ? ["verified", "rejected"].includes(b)
        : false;
export function captureMaterialPreparationReservation(
  input: Input<"reserve">,
): Input<"reserve"> {
  const p = createProjectMaterialPreparationInitial(input);
  return Object.freeze({
    request: p.request,
    source: p.source,
    target: p.target,
    proposedTransfer: Object.freeze({
      preparationId: p.transfer.preparationId,
      requestDigest: p.transfer.requestDigest,
    }),
    at: p.createdAt,
  });
}
export function captureMaterialPreparationClaim(
  input: Input<"claimDispatch">,
): Input<"claimDispatch"> {
  const r = materialPreparationFields(input, [
    "request",
    "expectedRevision",
    "at",
  ]);
  return Object.freeze({
    request: parseProjectMaterialPreparationRequest(r.request),
    expectedRevision: projectAssetRevision(r.expectedRevision),
    at: projectAssetTimestamp(r.at),
  });
}
export function captureMaterialPreparationAdvance(
  input: Input<"advance">,
): Input<"advance"> {
  const r = materialPreparationFields(input, [
    "request",
    "expectedRevision",
    "phase",
    "observation",
    "failureCode",
    "at",
  ]);
  if (!["unknownOutcome", "verified", "rejected"].includes(r.phase as string))
    fail("transition_invalid");
  let observation: ProjectMaterialPreparationEvent["observation"] = null;
  if (r.observation !== null) {
    const o = materialPreparationFields(r.observation, [
      "byteDigest",
      "byteLength",
      "width",
      "height",
      "checkedAt",
    ]);
    const byteLength = projectAssetRevision(o.byteLength),
      width = projectAssetRevision(o.width),
      height = projectAssetRevision(o.height);
    if (byteLength > 16 * 1024 * 1024 || width > 4096 || height > 4096)
      fail("observation_invalid");
    observation = Object.freeze({
      byteDigest: projectAssetDigest(o.byteDigest),
      byteLength,
      width,
      height,
      checkedAt: projectAssetTimestamp(o.checkedAt),
    });
  }
  return Object.freeze({
    request: parseProjectMaterialPreparationRequest(r.request),
    expectedRevision: projectAssetRevision(r.expectedRevision),
    phase: r.phase as Input<"advance">["phase"],
    observation,
    failureCode: r.failureCode === null ? null : projectAssetId(r.failureCode),
    at: projectAssetTimestamp(r.at),
  });
}

export function* qualifyMaterialPreparation(
  d: AssetDialect,
  initial: ProjectMaterialPreparationInitial,
  verifier: ProjectGenerationImageResultVerifier | undefined,
): MaterialPreparationPlan<void> {
  const frozen = initial.source,
    s = frozen.source;
  const source = yield* loadAssetReferenceImagePlan(
    d,
    {
      actor: initial.request.source.actor,
      query: initial.request.source.query,
    },
    verifier,
  );
  const expected = {
    assetRevision: source.asset.revision,
    contentRevision: source.content.contentRevision,
    contentDigest: source.content.contentDigest,
    referenceRevision: source.reference.referenceRevision,
    referenceDigest: source.reference.contentDigest,
    resultLinkDigest: source.resultLink.contentDigest,
    sourceBindingDigest: source.resultLink.sourceBindingDigest,
    sourceRunId: source.resultLink.sourceRunId,
    operationId: source.resultLink.operationId,
    pluginId: source.resultLink.pluginId,
    pluginVersion: source.resultLink.pluginVersion,
    packageDigest: source.resultLink.packageDigest,
    configurationRevision: source.configuration.revision,
    configurationDigest: source.configuration.contentDigest,
    origin: new URL(source.resultLink.image.url).origin + "/",
  };
  if (
    Object.entries(expected).some(([k, v]) => s[k as keyof typeof s] !== v) ||
    s.output.filename !== source.resultLink.image.filename
  )
    fail("source_changed");
  const c = initial.target.configuration;
  const rows = yield* assetQuery(
    d,
    `SELECT * FROM ${d.prefix}extension_configurations WHERE tenant_id=$1 AND space_id=$2 AND plugin_id=$3 AND revision=$4`,
    [c.tenantId, c.spaceId, c.pluginId, c.revision],
  );
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    row.tenant_id !== c.tenantId ||
    row.space_id !== c.spaceId ||
    row.plugin_id !== c.pluginId ||
    String(row.revision) !== String(c.revision) ||
    !same(
      parseExtensionConfiguration(
        record(row.configuration_json),
        creativeStoreDigester,
      ),
      c,
    )
  )
    fail("configuration_changed");
  // Store runners use only the original three installation tables on this same connection.
  // This carries data; external preparation authority is independently mandatory.
  yield { installation: initial.target };
}
export function* loadMaterialPreparation(
  d: AssetDialect,
  input: ProjectMaterialPreparationRequest,
  verifier: ProjectGenerationImageResultVerifier | undefined,
): MaterialPreparationPlan<ProjectMaterialPreparationState | null> {
  const request = parseProjectMaterialPreparationRequest(input),
    actor = request.source.actor,
    projectId = request.source.query.projectId,
    identity = projectMaterialPreparationIdentity(request);
  yield* assetLock(d, [
    "creative-project-project",
    d.schema,
    actor.tenantId,
    actor.spaceId,
    projectId,
  ]);
  const project = yield* assetProject(d, assetOwner(actor), projectId);
  if (project.state !== "active") fail("project_archived");
  const rows = yield* assetQuery(
    d,
    `SELECT * FROM ${d.prefix}project_material_preparations WHERE intent_id=$1`,
    [identity.intentId],
  );
  if (rows.length === 0) return null;
  if (rows.length !== 1) fail("record_invalid");
  const row = rows[0]!,
    initial = parseProjectMaterialPreparationInitial(record(row.record_json));
  const indexes = {
    intent_id: initial.intentId,
    tenant_id: actor.tenantId,
    space_id: actor.spaceId,
    principal_id: actor.principalId,
    actor_id: actor.actorId,
    project_id: projectId,
    idempotency_key: request.idempotencyKey,
    request_digest: initial.requestDigest,
    preparation_id: initial.transfer.preparationId,
    content_digest: initial.contentDigest,
  };
  if (Object.entries(indexes).some(([k, v]) => row[k] !== v))
    fail("record_index_mismatch");
  if (
    initial.requestDigest !== identity.requestDigest ||
    !same(initial.request, request)
  )
    fail("idempotency_conflict");
  const history = yield* assetQuery(
    d,
    `SELECT * FROM ${d.prefix}project_material_preparation_events WHERE intent_id=$1 ORDER BY revision LIMIT 5`,
    [initial.intentId],
  );
  const heads = yield* assetQuery(
    d,
    `SELECT * FROM ${d.prefix}project_material_preparation_heads WHERE intent_id=$1`,
    [initial.intentId],
  );
  if (history.length < 1 || history.length > 4 || heads.length !== 1)
    fail("history_invalid");
  let previous: ProjectMaterialPreparationEvent | null = null;
  for (const h of history) {
    const event = parseProjectMaterialPreparationEvent(
      record(h.record_json),
      initial,
    );
    if (
      event.intentId !== h.intent_id ||
      event.initialDigest !== h.initial_digest ||
      String(event.revision) !== String(h.revision) ||
      event.phase !== h.phase ||
      event.revision !== (previous?.revision ?? 0) + 1 ||
      (previous &&
        (!allowed(previous.phase, event.phase) || event.at < previous.at))
    )
      fail("history_invalid");
    previous = event;
  }
  const head = heads[0]!;
  if (
    head.intent_id !== initial.intentId ||
    String(head.revision) !== String(previous!.revision) ||
    head.phase !== previous!.phase
  )
    fail("history_invalid");
  yield* qualifyMaterialPreparation(d, initial, verifier);
  return Object.freeze({ initial, event: previous! });
}
export function* reserveMaterialPreparation(
  d: AssetDialect,
  input: Input<"reserve">,
  verifier: ProjectGenerationImageResultVerifier | undefined,
): MaterialPreparationPlan<
  Awaited<ReturnType<ProjectMaterialPreparationStore["reserve"]>>
> {
  const proposed = createProjectMaterialPreparationInitial(input),
    existing = yield* loadMaterialPreparation(d, proposed.request, verifier);
  if (existing) {
    if (
      frozenProjectMaterialFingerprint(existing.initial.source) !==
        frozenProjectMaterialFingerprint(proposed.source) ||
      !same(existing.initial.target, proposed.target)
    )
      fail("idempotency_conflict");
    return Object.freeze({ disposition: "replayed", state: existing });
  }
  yield* qualifyMaterialPreparation(d, proposed, verifier);
  const reused = yield* assetQuery(
    d,
    `SELECT intent_id FROM ${d.prefix}project_material_preparations WHERE preparation_id=$1`,
    [proposed.transfer.preparationId],
  );
  if (reused.length) fail("transfer_identity_conflict");
  const actor = proposed.request.source.actor;
  yield* assetQuery(
    d,
    `INSERT INTO ${d.prefix}project_material_preparations(intent_id,tenant_id,space_id,principal_id,actor_id,project_id,idempotency_key,request_digest,preparation_id,content_digest,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      proposed.intentId,
      actor.tenantId,
      actor.spaceId,
      actor.principalId,
      actor.actorId,
      proposed.request.source.query.projectId,
      proposed.request.idempotencyKey,
      proposed.requestDigest,
      proposed.transfer.preparationId,
      proposed.contentDigest,
      extensionCanonicalJson(proposed),
    ],
  );
  const event = parseProjectMaterialPreparationEvent(
    {
      intentId: proposed.intentId,
      initialDigest: proposed.contentDigest,
      revision: 1,
      phase: "reserved",
      observation: null,
      failureCode: null,
      at: proposed.createdAt,
    },
    proposed,
  );
  yield* insertEvent(d, event);
  yield* assetQuery(
    d,
    `INSERT INTO ${d.prefix}project_material_preparation_heads(intent_id,revision,phase) VALUES($1,1,'reserved')`,
    [proposed.intentId],
  );
  return Object.freeze({
    disposition: "created",
    state: Object.freeze({ initial: proposed, event }),
  });
}
export function* claimMaterialPreparation(
  d: AssetDialect,
  input: Input<"claimDispatch">,
  verifier: ProjectGenerationImageResultVerifier | undefined,
): MaterialPreparationPlan<
  Awaited<ReturnType<ProjectMaterialPreparationStore["claimDispatch"]>>
> {
  const r = materialPreparationFields(input, [
      "request",
      "expectedRevision",
      "at",
    ]),
    request = parseProjectMaterialPreparationRequest(r.request),
    expected = projectAssetRevision(r.expectedRevision),
    at = projectAssetTimestamp(r.at);
  const state = yield* loadMaterialPreparation(d, request, verifier);
  if (!state) fail("not_found");
  if (state.event.phase !== "reserved")
    return Object.freeze({ disposition: "existing", state });
  if (expected !== state.event.revision) fail("revision_conflict");
  const result = yield* appendEvent(d, state, {
    phase: "dispatching",
    observation: null,
    failureCode: null,
    at,
  });
  return Object.freeze({ disposition: "claimed", state: result });
}
export function* advanceMaterialPreparation(
  d: AssetDialect,
  input: Input<"advance">,
  verifier: ProjectGenerationImageResultVerifier | undefined,
): MaterialPreparationPlan<ProjectMaterialPreparationState> {
  const r = materialPreparationFields(input, [
      "request",
      "expectedRevision",
      "phase",
      "observation",
      "failureCode",
      "at",
    ]),
    request = parseProjectMaterialPreparationRequest(r.request),
    expected = projectAssetRevision(r.expectedRevision),
    state = yield* loadMaterialPreparation(d, request, verifier);
  if (!state) fail("not_found");
  if (expected !== state.event.revision) fail("revision_conflict");
  if (!["unknownOutcome", "verified", "rejected"].includes(r.phase as string))
    fail("transition_invalid");
  return yield* appendEvent(d, state, {
    phase: r.phase as ProjectMaterialPreparationEvent["phase"],
    observation:
      r.observation as ProjectMaterialPreparationEvent["observation"],
    failureCode: r.failureCode as string | null,
    at: r.at as string,
  });
}
function* insertEvent(
  d: AssetDialect,
  e: ProjectMaterialPreparationEvent,
): MaterialPreparationPlan<void> {
  yield* assetQuery(
    d,
    `INSERT INTO ${d.prefix}project_material_preparation_events(intent_id,initial_digest,revision,phase,record_json) VALUES($1,$2,$3,$4,$5)`,
    [
      e.intentId,
      e.initialDigest,
      e.revision,
      e.phase,
      extensionCanonicalJson(e),
    ],
  );
}
function* appendEvent(
  d: AssetDialect,
  s: ProjectMaterialPreparationState,
  next: Pick<
    ProjectMaterialPreparationEvent,
    "phase" | "observation" | "failureCode" | "at"
  >,
): MaterialPreparationPlan<ProjectMaterialPreparationState> {
  if (!allowed(s.event.phase, next.phase) || next.at < s.event.at)
    fail("transition_invalid");
  const event = parseProjectMaterialPreparationEvent(
    {
      ...next,
      intentId: s.initial.intentId,
      initialDigest: s.initial.contentDigest,
      revision: s.event.revision + 1,
    },
    s.initial,
  );
  yield* insertEvent(d, event);
  const rows = yield* assetQuery(
    d,
    `UPDATE ${d.prefix}project_material_preparation_heads SET revision=$2,phase=$3 WHERE intent_id=$1 AND revision=$4 AND phase=$5 RETURNING intent_id`,
    [
      s.initial.intentId,
      event.revision,
      event.phase,
      s.event.revision,
      s.event.phase,
    ],
  );
  if (rows.length !== 1) fail("revision_conflict");
  return Object.freeze({ initial: s.initial, event });
}
function fail(code: string): never {
  throw new Error(`project_material_preparation_${code}`);
}
