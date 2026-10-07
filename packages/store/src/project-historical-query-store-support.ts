import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type {
  ActorContext,
  CommitExtensionTurnInput,
  CommitExtensionTurnOptions,
  CreativeProjectCommitAuthority,
  ExtensionMutationReceipt,
  ExtensionRunLocator,
  ProjectHistoricalQueryExecutionPublication,
} from "@crewon/application";
import { captureCreativeProjectCommitAuthority } from "@crewon/application";
import {
  assertProjectHistoricalQueryExecutionPublication,
  assertProjectHistoricalQueryReplay,
  createProjectHistoricalQueryLink,
  creativeProjectDigest,
  extensionCanonicalJson,
  parseExtensionConfiguration,
  parsePluginTaskAdmissionPin,
  parseProjectHistoricalQueryLink,
  parseProjectHistoricalQueryPublication,
  parseProjectQueryReference,
  type ExtensionRunBinding,
  type PluginQueryTaskAdmission,
  type ProjectGenerationLink,
  type ProjectHistoricalQueryLink,
  type ProjectQueryReference,
} from "@crewon/domain";
import { creativeStoreRecord } from "./creative-project-store-records.ts";
import {
  decodeProjectGenerationSource,
  projectGenerationSourceReadSql,
  projectGenerationSourceValues,
} from "./project-generation-source-read.ts";
import {
  extensionStoreDigester,
  parseExtensionTurnReceipt,
} from "./extension-store-records.ts";
import {
  admitPostgresPluginTaskPin,
  admitSqlitePluginTaskPin,
} from "./plugin-task-admission-store-support.ts";
import {
  loadPostgresPluginQuery,
  loadSqlitePluginQuery,
} from "./plugin-query-task-store-support.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { projectGenerationLocator } from "./project-generation-store-support.ts";

export type PreparedProjectHistoricalQuery = Readonly<{
  reference: ProjectQueryReference;
  generationLinkDigest: string;
  actor: ActorContext;
  publication: ProjectHistoricalQueryExecutionPublication;
  authority: CreativeProjectCommitAuthority;
}>;
export function captureProjectHistoricalQuery(
  input: CommitExtensionTurnInput,
  query: PluginQueryTaskAdmission | undefined,
  enabled: boolean,
  options?: CommitExtensionTurnOptions,
): PreparedProjectHistoricalQuery | null {
  const field = Object.getOwnPropertyDescriptor(
    input,
    "projectHistoricalQuery",
  );
  if (
    (field === undefined && "projectHistoricalQuery" in input) ||
    (field !== undefined &&
      (!field.enumerable || !Object.hasOwn(field, "value")))
  )
    throw new Error("project_historical_query_reference_invalid");
  if (field?.value === undefined) {
    if (
      options !== undefined &&
      ("projectHistoricalQueryAuthority" in options ||
        "projectHistoricalQueryPublication" in options)
    )
      throw new Error("project_historical_query_reference_required");
    return null;
  }
  if (!enabled) throw new Error("project_historical_query_unavailable");
  if (
    query === undefined ||
    input.projectGeneration !== undefined ||
    input.projectQuery !== undefined ||
    input.pluginAdmission !== undefined ||
    input.creditAdmission !== undefined ||
    input.unmeteredAdmission !== undefined
  )
    throw new Error("project_historical_query_admission_required");
  const source = creativeStoreRecord(field.value, [
      "reference",
      "generationLinkDigest",
    ]),
    reference = parseProjectQueryReference(source.reference),
    generationLinkDigest = creativeProjectDigest(source.generationLinkDigest);
  const captured = hostFields(options, [
    "projectHistoricalQueryAuthority",
    "projectHistoricalQueryPublication",
  ]);
  const authority = captureCreativeProjectCommitAuthority({
    authority:
      captured.projectHistoricalQueryAuthority as CreativeProjectCommitAuthority,
  });
  if (authority === undefined || authority.transaction !== undefined)
    throw new Error("project_historical_query_authority_required");
  const publicationFields = creativeStoreRecord(
    captured.projectHistoricalQueryPublication,
    ["publication", "sourcePin", "executionPin"],
  );
  const publication = Object.freeze({
    publication: parseProjectHistoricalQueryPublication(
      publicationFields.publication,
    ),
    sourcePin: parsePluginTaskAdmissionPin(publicationFields.sourcePin),
    executionPin: parsePluginTaskAdmissionPin(publicationFields.executionPin),
  });
  assertProjectHistoricalQueryExecutionPublication(publication);
  if (
    extensionCanonicalJson(queryPin(query)) !==
    extensionCanonicalJson(publication.executionPin)
  )
    throw new Error("project_historical_query_execution_admission_mismatch");
  const actor = Object.freeze({
    tenantId: query.tenantId,
    spaceId: query.spaceId,
    principalId: query.principalId,
    actorId: query.actorId,
  });
  return Object.freeze({
    reference,
    generationLinkDigest,
    actor,
    publication,
    authority,
  });
}
function queryPin(query: PluginQueryTaskAdmission) {
  const {
    schemaVersion: _schema,
    runId: _run,
    threadId: _thread,
    extensionBindingDigest: _binding,
    requestDigest: _request,
    idempotencyKey: _key,
    source: _source,
    operationId: _op,
    ...pin
  } = query;
  return parsePluginTaskAdmissionPin(pin);
}
function orderedPins(publication: ProjectHistoricalQueryExecutionPublication) {
  const key = (pin: typeof publication.sourcePin) =>
    JSON.stringify([pin.tenantId, pin.spaceId, pin.profileId, pin.pluginId]);
  return [publication.sourcePin, publication.executionPin].sort((a, b) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
  );
}
export function admitSqliteProjectHistoricalQueryPublication(
  db: DatabaseSync,
  prepared: PreparedProjectHistoricalQuery,
): void {
  for (const pin of orderedPins(prepared.publication))
    admitSqlitePluginTaskPin(db, pin);
}
export async function admitPostgresProjectHistoricalQueryPublication(
  client: PoolClient,
  schema: string,
  prepared: PreparedProjectHistoricalQuery,
): Promise<void> {
  for (const pin of orderedPins(prepared.publication))
    await admitPostgresPluginTaskPin(client, schema, pin);
}
function locator(
  prepared: Pick<PreparedProjectHistoricalQuery, "reference" | "actor">,
) {
  return {
    owner: {
      tenantId: prepared.actor.tenantId,
      spaceId: prepared.actor.spaceId,
      principalId: prepared.actor.principalId,
    },
    ...prepared.reference,
  };
}
function validateGenerationSource(
  link: ProjectGenerationLink | null,
  digest: string,
  query: PluginQueryTaskAdmission,
): ProjectGenerationLink {
  if (
    link === null ||
    link.contentDigest !== digest ||
    link.binding.runId !== query.source.runId ||
    link.binding.bindingDigest !== query.source.extensionBindingDigest ||
    link.ownerPrincipalId !== query.principalId
  )
    throw new Error("project_historical_query_source_mismatch");
  return link;
}
function validateConfiguration(
  row: Record<string, unknown> | undefined,
  source: ProjectGenerationLink,
  query: PluginQueryTaskAdmission,
  publication: import("@crewon/domain").ProjectHistoricalQueryPublication,
) {
  const config = parseExtensionConfiguration(
    json(row?.configuration_json),
    extensionStoreDigester,
  );
  if (
    config.tenantId !== source.tenantId ||
    config.spaceId !== source.spaceId ||
    config.pluginId !== source.binding.pluginId ||
    config.revision !== source.binding.configurationRevision ||
    config.contentDigest !== source.binding.configurationDigest ||
    config.pluginVersion !== query.source.version ||
    config.manifestDigest !== publication.target.manifestDigest ||
    config.implementationDigest !== publication.target.implementationDigest
  )
    throw new Error("project_historical_query_source_configuration_mismatch");
}
const configurationSql = (prefix: string, pg: boolean) =>
  `SELECT configuration_json FROM ${prefix}extension_configurations WHERE tenant_id=${pg ? "$1" : "?"} AND space_id=${pg ? "$2" : "?"} AND plugin_id=${pg ? "$3" : "?"} AND revision=${pg ? "$4" : "?"}`;
const configValues = (source: ProjectGenerationLink) => [
  source.tenantId,
  source.spaceId,
  source.binding.pluginId,
  source.binding.configurationRevision,
];
export function prepareSqliteProjectHistoricalQuery(
  db: DatabaseSync,
  prepared: PreparedProjectHistoricalQuery,
  input: CommitExtensionTurnInput,
  query: PluginQueryTaskAdmission,
): ProjectHistoricalQueryLink {
  const sourceLocator = locator(prepared),
    source = validateGenerationSource(
      decodeProjectGenerationSource(
        db
          .prepare(projectGenerationSourceReadSql())
          .all(...projectGenerationSourceValues(sourceLocator)),
        sourceLocator,
      ),
      prepared.generationLinkDigest,
      query,
    );
  validateConfiguration(
    db.prepare(configurationSql("", false)).get(...configValues(source)),
    source,
    query,
    prepared.publication.publication,
  );
  return createLink(prepared, input, query, source);
}
export async function preparePostgresProjectHistoricalQuery(
  client: PoolClient,
  schema: string,
  prepared: PreparedProjectHistoricalQuery,
  input: CommitExtensionTurnInput,
  query: PluginQueryTaskAdmission,
): Promise<ProjectHistoricalQueryLink> {
  const prefix = `${creativeProjectSchemaName(schema)}.`,
    sourceLocator = locator(prepared);
  const rows = await client.query(
    projectGenerationSourceReadSql(prefix, true),
    projectGenerationSourceValues(sourceLocator),
  );
  const source = validateGenerationSource(
    decodeProjectGenerationSource(rows.rows, sourceLocator),
    prepared.generationLinkDigest,
    query,
  );
  validateConfiguration(
    (await client.query(configurationSql(prefix, true), configValues(source)))
      .rows[0],
    source,
    query,
    prepared.publication.publication,
  );
  return createLink(prepared, input, query, source);
}
function createLink(
  prepared: PreparedProjectHistoricalQuery,
  input: CommitExtensionTurnInput,
  query: PluginQueryTaskAdmission,
  source: ProjectGenerationLink,
) {
  const event = input.turn.run.events[0];
  if (event?.type !== "run.created")
    throw new Error("project_historical_query_run_invalid");
  return createProjectHistoricalQueryLink(
    {
      actor: prepared.actor,
      reference: prepared.reference,
      generationLink: source,
      queryAdmission: query,
      binding: input.binding,
      receipt: input.receipt,
      ...prepared.publication,
      at: event.occurredAt,
    },
    extensionStoreDigester,
  );
}
export function assertProjectHistoricalQueryReceipt(
  prepared: PreparedProjectHistoricalQuery | null,
  link: ProjectHistoricalQueryLink | null,
  binding: ExtensionRunBinding,
  receipt: ExtensionMutationReceipt,
): void {
  if (prepared === null && link === null) return;
  if (prepared === null || link === null)
    throw new Error("project_historical_query_receipt_conflict");
  assertProjectHistoricalQueryReplay(
    {
      link,
      reference: prepared.reference,
      generationLinkDigest: prepared.generationLinkDigest,
      actor: prepared.actor,
      binding,
      receipt,
      ...prepared.publication,
    },
    extensionStoreDigester,
  );
}
export function projectHistoricalQueryReadSql(prefix = "", pg = false) {
  return `SELECT l.*,a.project_historical_query_digest AS historical_query_digest,b.binding_json,r.request_digest AS stored_request_digest,r.result_json AS stored_result_json FROM ${prefix}creative_project_historical_query_links l LEFT JOIN ${prefix}plugin_query_task_admissions a ON a.tenant_id=l.tenant_id AND a.run_id=l.run_id LEFT JOIN ${prefix}extension_run_bindings b ON b.tenant_id=l.tenant_id AND b.run_id=l.run_id LEFT JOIN ${prefix}extension_mutation_receipts r ON r.tenant_id=l.tenant_id AND r.space_id=l.space_id AND r.plugin_id=l.plugin_id AND r.kind=l.receipt_kind AND r.actor_id=l.actor_id AND r.idempotency_key=l.idempotency_key WHERE l.tenant_id=${pg ? "$1" : "?"} AND l.space_id=${pg ? "$2" : "?"} AND l.run_id=${pg ? "$3" : "?"}`;
}
function decode(
  row: Record<string, unknown> | undefined,
  input: ExtensionRunLocator,
): ProjectHistoricalQueryLink | null {
  if (row === undefined) return null;
  const raw =
    typeof row.record_json === "string"
      ? row.record_json
      : JSON.stringify(row.record_json);
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 32_768)
    throw new Error("project_historical_query_record_invalid");
  const link = parseProjectHistoricalQueryLink(
      JSON.parse(raw),
      extensionStoreDigester,
    ),
    binding = json(row.binding_json);
  const fields = {
    tenant_id: link.tenantId,
    space_id: link.spaceId,
    project_id: link.projectId,
    owner_principal_id: link.ownerPrincipalId,
    asset_id: link.reference.assetId,
    asset_revision: link.reference.assetRevision,
    generation_link_digest: link.generationLinkDigest,
    source_run_id: link.sourceRunId,
    source_binding_digest: link.sourceBindingDigest,
    operation_id: link.operationId,
    plugin_id: link.binding.pluginId,
    run_id: link.binding.runId,
    thread_id: link.binding.threadId,
    actor_id: link.receipt.actorId,
    binding_digest: link.binding.bindingDigest,
    receipt_kind: "task",
    idempotency_key: link.receipt.idempotencyKey,
    request_digest: link.receipt.requestDigest,
    content_digest: link.contentDigest,
  };
  if (
    Object.entries(fields).some(
      ([key, value]) => String(row[key]) !== String(value),
    ) ||
    link.tenantId !== input.tenantId ||
    link.spaceId !== input.spaceId ||
    link.binding.runId !== input.runId ||
    extensionCanonicalJson(binding) !== extensionCanonicalJson(link.binding) ||
    row.stored_request_digest !== link.receipt.requestDigest ||
    row.historical_query_digest !== link.contentDigest
  )
    throw new Error("project_historical_query_record_identity_mismatch");
  const saved = parseExtensionTurnReceipt(
    json(row.stored_result_json),
    link.binding,
    link.receipt,
  );
  if (
    saved.creditAdmission !== undefined ||
    saved.unmeteredAdmission !== undefined ||
    saved.run.events[0]?.occurredAt !== link.createdAt
  )
    throw new Error("project_historical_query_receipt_identity_mismatch");
  return link;
}
function loadPrepared(
  link: ProjectHistoricalQueryLink,
): Pick<PreparedProjectHistoricalQuery, "actor" | "reference"> {
  return {
    actor: {
      tenantId: link.tenantId,
      spaceId: link.spaceId,
      principalId: link.ownerPrincipalId,
      actorId: link.receipt.actorId,
    },
    reference: link.reference,
  };
}
function verifySaved(
  link: ProjectHistoricalQueryLink,
  query: PluginQueryTaskAdmission | null,
  source: ProjectGenerationLink,
  config: Record<string, unknown> | undefined,
): ProjectHistoricalQueryLink {
  if (query === null)
    throw new Error("project_historical_query_admission_missing");
  validateConfiguration(config, source, query, link.publication);
  const rebuilt = createProjectHistoricalQueryLink(
    {
      actor: loadPrepared(link).actor,
      reference: link.reference,
      generationLink: source,
      queryAdmission: query,
      binding: link.binding,
      receipt: link.receipt,
      publication: link.publication,
      sourcePin: link.sourcePin,
      executionPin: link.executionPin,
      at: link.createdAt,
    },
    extensionStoreDigester,
  );
  if (extensionCanonicalJson(link) !== extensionCanonicalJson(rebuilt))
    throw new Error("project_historical_query_record_source_mismatch");
  return link;
}
export function loadSqliteProjectHistoricalQueryLink(
  db: DatabaseSync,
  input: ExtensionRunLocator,
): ProjectHistoricalQueryLink | null {
  const link = decode(
    db
      .prepare(projectHistoricalQueryReadSql())
      .get(...projectGenerationLocator(input)),
    input,
  );
  if (link === null) return null;
  const query = loadSqlitePluginQuery(db, input),
    prepared = loadPrepared(link),
    sourceLocator = locator(prepared);
  if (query === null)
    throw new Error("project_historical_query_admission_missing");
  const source = validateGenerationSource(
    decodeProjectGenerationSource(
      db
        .prepare(projectGenerationSourceReadSql())
        .all(...projectGenerationSourceValues(sourceLocator)),
      sourceLocator,
    ),
    link.generationLinkDigest,
    query,
  );
  return verifySaved(
    link,
    query,
    source,
    db.prepare(configurationSql("", false)).get(...configValues(source)),
  );
}
export async function loadPostgresProjectHistoricalQueryLink(
  client: PoolClient,
  schema: string,
  input: ExtensionRunLocator,
): Promise<ProjectHistoricalQueryLink | null> {
  const prefix = `${creativeProjectSchemaName(schema)}.`,
    link = decode(
      (
        await client.query(
          projectHistoricalQueryReadSql(prefix, true),
          projectGenerationLocator(input),
        )
      ).rows[0],
      input,
    );
  if (link === null) return null;
  const query = await loadPostgresPluginQuery(client, schema, input),
    prepared = loadPrepared(link),
    sourceLocator = locator(prepared);
  if (query === null)
    throw new Error("project_historical_query_admission_missing");
  const source = validateGenerationSource(
    decodeProjectGenerationSource(
      (
        await client.query(
          projectGenerationSourceReadSql(prefix, true),
          projectGenerationSourceValues(sourceLocator),
        )
      ).rows,
      sourceLocator,
    ),
    link.generationLinkDigest,
    query,
  );
  return verifySaved(
    link,
    query,
    source,
    (await client.query(configurationSql(prefix, true), configValues(source)))
      .rows[0],
  );
}
export function projectHistoricalQueryValues(link: ProjectHistoricalQueryLink) {
  return [
    link.tenantId,
    link.spaceId,
    link.projectId,
    link.ownerPrincipalId,
    link.reference.assetId,
    link.reference.assetRevision,
    link.generationLinkDigest,
    link.sourceRunId,
    link.sourceBindingDigest,
    link.operationId,
    link.binding.pluginId,
    link.binding.runId,
    link.binding.threadId,
    link.receipt.actorId,
    link.binding.bindingDigest,
    "task",
    link.receipt.idempotencyKey,
    link.receipt.requestDigest,
    link.contentDigest,
    JSON.stringify(link),
  ];
}
export function projectHistoricalQueryInsertSql(prefix = "", pg = false) {
  return `INSERT INTO ${prefix}creative_project_historical_query_links VALUES(${Array.from({ length: 20 }, (_, i) => (pg ? `$${i + 1}` : "?")).join(",")})`;
}
function json(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function hostFields(
  input: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== fields.length ||
    Reflect.ownKeys(input).some(
      (key) => typeof key !== "string" || !fields.includes(key),
    )
  )
    throw new Error("project_historical_query_authority_required");
  return Object.freeze(
    Object.fromEntries(
      fields.map((field) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, field);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value")
        )
          throw new Error("project_historical_query_authority_required");
        return [field, descriptor.value];
      }),
    ),
  );
}

export function stripProjectHistoricalQueryOptions(
  options: CommitExtensionTurnOptions | undefined,
): CommitExtensionTurnOptions | undefined {
  // An inactive historical-query path must leave another operation's options
  // untouched so that its owning validator rejects accessors without reading them.
  if (
    options === undefined ||
    (!("projectHistoricalQueryAuthority" in options) &&
      !("projectHistoricalQueryPublication" in options))
  )
    return options;
  const keys = Reflect.ownKeys(options),
    out: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string")
      throw new Error("project_historical_query_authority_required");
    const d = Object.getOwnPropertyDescriptor(options, key);
    if (!d?.enumerable || !("value" in d))
      throw new Error("project_historical_query_authority_required");
    if (
      key !== "projectHistoricalQueryAuthority" &&
      key !== "projectHistoricalQueryPublication"
    )
      out[key] = d.value;
  }
  return Object.keys(out).length === 0
    ? undefined
    : (Object.freeze(out) as CommitExtensionTurnOptions);
}
