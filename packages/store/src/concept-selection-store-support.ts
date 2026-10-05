import { assertPluginTaskFunding } from "@crewon/domain";
import {
  decodePluginTaskUnmeteredRecord,
  assertUnmeteredReceipt,
} from "./plugin-task-unmetered-store-support.ts";
import {
  selectionFields,
  jsonRecord,
  captureConceptSelectionReceipt,
  captureConceptSelectionRead,
  type PreparedConceptSelection,
} from "./concept-selection-capture.ts";
export {
  captureConceptSelection,
  captureConceptSelectionRead,
  captureConceptSelectionReceipt,
} from "./concept-selection-capture.ts";
import { decodeExtensionCreditAdmission } from "./extension-credit-admission-records.ts";
import type {
  CommitProjectConceptSelectionInput,
  CommitProjectConceptSelectionResult,
  CreativeProjectOwnerScope,
  ActorContext,
  ProjectGenerationImageResultVerifier,
  CurrentConceptSelectionReadResult,
  ProjectConceptSelectionCommandSource,
} from "@crewon/application";
import { verifyProjectGenerationImage } from "@crewon/application";
import {
  assertConceptSelectionResult,
  createCurrentConceptSelection,
  createOperationResultLink,
  assertPluginTaskAdmission,
  assertExtensionCreditAdmission,
  extensionCanonicalJson,
  parseCurrentConceptSelection,
  parseOperationResultLink,
  parseExtensionConfiguration,
  parseExtensionActivation,
  validateProjectGenerationSource,
  type CurrentConceptSelection,
  type OperationResultLink,
} from "@crewon/domain";
import {
  creativeStoreRecord,
  decodeCreativeProject,
  decodeCreativeAsset,
  decodeCreativeRevision,
  decodeCreativeBrief,
} from "./creative-project-store-records.ts";
import {
  decodeProjectGenerationSource,
  projectGenerationSourceReadSql,
  projectGenerationSourceValues,
} from "./project-generation-source-read.ts";
import {
  admissionQuery,
  decodePluginTaskAdmissionRecord,
} from "./plugin-task-admission-store-support.ts";
import { parseExternalOperation } from "./external-operation-record.ts";
import {
  parseExtensionTurnReceipt,
  extensionStoreDigester as digester,
} from "./extension-store-records.ts";

export type SelectionSql = Readonly<{
  sql: string;
  values: readonly (string | number)[];
}>;
export type SelectionRows = readonly Record<string, unknown>[];
export type SelectionPlan<T> = Generator<SelectionSql, T, SelectionRows>;
export type SelectionDialect = Readonly<{
  postgres: boolean;
  prefix: string;
  schema: string;
}>;
const linkTable = "creative_operation_result_links",
  pointerTable = "creative_current_concept_selections",
  receiptTable = "creative_concept_selection_receipts";
const ownerFor = (actor: ActorContext): CreativeProjectOwnerScope =>
  Object.freeze({
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    principalId: actor.principalId,
  });
// Shared proof readers stay on the caller's real connection; no new selection is written.
export {
  source as verifyConceptSelectionSourcePlan,
  pointer as loadConceptSelectionPointerPlan,
  linkedResult as loadConceptSelectionResultPlan,
};
const ownerValues = (owner: CreativeProjectOwnerScope) => [
  owner.tenantId,
  owner.spaceId,
  owner.principalId,
];
function request(input: CommitProjectConceptSelectionInput) {
  const {
    reference,
    operationId,
    expectedOperationRevision,
    resultIndex,
    expectedSelectionRevision,
  } = input;
  return Object.freeze({
    reference,
    operationId,
    expectedOperationRevision,
    resultIndex,
    expectedSelectionRevision,
  });
}
function sourceIdentity(source: ProjectConceptSelectionCommandSource) {
  switch (source.kind) {
    case "authenticated-project-command":
      return { kind: source.kind };
    case "installed-plugin-ui": {
      const {
        selectionRevision: _revision,
        authorityEpoch: _epoch,
        ...identity
      } = source.publication.sourcePin;
      return { kind: source.kind, pin: identity };
    }
  }
}
function* query(
  d: SelectionDialect,
  sql: string,
  values: readonly (string | number)[] = [],
): SelectionPlan<SelectionRows> {
  if (d.postgres) return yield { sql, values };
  const ordered: (string | number)[] = [];
  const sqliteSql = sql.replaceAll(/\$([0-9]+)/gu, (_marker, index: string) => {
    const value = values[Number(index) - 1];
    if (value === undefined)
      throw new Error("concept_selection_sql_parameter_invalid");
    ordered.push(value);
    return "?";
  });
  return yield { sql: sqliteSql, values: ordered };
}
function* lock(
  d: SelectionDialect,
  key: readonly unknown[],
): SelectionPlan<void> {
  if (d.postgres)
    yield* query(d, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify(key),
    ]);
}
const same = (left: unknown, right: unknown) => {
  if (String(left) !== String(right))
    throw new Error("concept_selection_record_index_mismatch");
};
function decodeLink(
  row: Record<string, unknown> | undefined,
  owner: CreativeProjectOwnerScope,
): OperationResultLink | null {
  if (!row) return null;
  const link = parseOperationResultLink(jsonRecord(row.record_json), digester);
  for (const [column, value] of Object.entries({
    tenant_id: link.tenantId,
    space_id: link.spaceId,
    project_id: link.projectId,
    owner_principal_id: link.ownerPrincipalId,
    asset_id: link.reference.assetId,
    asset_revision: link.reference.assetRevision,
    source_run_id: link.sourceRunId,
    source_binding_digest: link.sourceBindingDigest,
    operation_id: link.operationId,
    operation_revision: link.operationRevision,
    result_index: link.image.resultIndex,
    content_digest: link.contentDigest,
  }))
    same(row[column], value);
  if (
    link.tenantId !== owner.tenantId ||
    link.spaceId !== owner.spaceId ||
    link.ownerPrincipalId !== owner.principalId
  )
    throw new Error("concept_selection_owner_mismatch");
  return link;
}
function decodePointer(
  row: Record<string, unknown> | undefined,
  owner: CreativeProjectOwnerScope,
): CurrentConceptSelection | null {
  if (!row) return null;
  const pointer = parseCurrentConceptSelection(
    jsonRecord(row.record_json),
    digester,
  );
  for (const [column, value] of Object.entries({
    tenant_id: pointer.tenantId,
    space_id: pointer.spaceId,
    project_id: pointer.projectId,
    owner_principal_id: pointer.ownerPrincipalId,
    asset_id: pointer.assetId,
    selection_revision: pointer.selectionRevision,
    result_link_digest: pointer.resultLinkDigest,
  }))
    same(row[column], value);
  if (
    pointer.tenantId !== owner.tenantId ||
    pointer.spaceId !== owner.spaceId ||
    pointer.ownerPrincipalId !== owner.principalId
  )
    throw new Error("concept_selection_owner_mismatch");
  return pointer;
}
function* pointer(
  d: SelectionDialect,
  owner: CreativeProjectOwnerScope,
  projectId: string,
  assetId: string,
): SelectionPlan<CurrentConceptSelection | null> {
  const rows = yield* query(
    d,
    `SELECT * FROM ${d.prefix}${pointerTable} WHERE tenant_id=$1 AND space_id=$2 AND owner_principal_id=$3 AND project_id=$4 AND asset_id=$5`,
    [...ownerValues(owner), projectId, assetId],
  );
  return decodePointer(rows[0], owner);
}
function* linkedResult(
  d: SelectionDialect,
  owner: CreativeProjectOwnerScope,
  p: CurrentConceptSelection,
): SelectionPlan<OperationResultLink> {
  const rows = yield* query(
      d,
      `SELECT * FROM ${d.prefix}${linkTable} WHERE tenant_id=$1 AND space_id=$2 AND owner_principal_id=$3 AND project_id=$4 AND asset_id=$5 AND content_digest=$6`,
      [...ownerValues(owner), p.projectId, p.assetId, p.resultLinkDigest],
    ),
    link = decodeLink(rows[0], owner);
  if (!link) throw new Error("concept_selection_result_missing");
  assertConceptSelectionResult(p, link);
  return link;
}
function* receipt(
  d: SelectionDialect,
  identity: ReturnType<typeof captureConceptSelectionReceipt>,
): SelectionPlan<Record<string, unknown> | null> {
  const rows = yield* query(
    d,
    `SELECT * FROM ${d.prefix}${receiptTable} WHERE tenant_id=$1 AND space_id=$2 AND principal_id=$3 AND actor_id=$4 AND idempotency_key=$5`,
    [
      identity.actor.tenantId,
      identity.actor.spaceId,
      identity.actor.principalId,
      identity.actor.actorId,
      identity.receipt.idempotencyKey,
    ],
  );
  const row = rows[0];
  if (!row) return null;
  const saved = selectionFields(jsonRecord(row.record_json), [
      "schemaVersion",
      "actor",
      "receipt",
      "request",
      "sourceIdentity",
      "pointer",
      "resultLinkDigest",
      "contentDigest",
    ]),
    { contentDigest, ...body } = saved;
  if (
    saved.schemaVersion !== "crewon.concept-selection-receipt.v1" ||
    digester.sha256(extensionCanonicalJson(body)) !== contentDigest ||
    extensionCanonicalJson(saved.actor) !==
      extensionCanonicalJson(identity.actor) ||
    extensionCanonicalJson(saved.receipt) !==
      extensionCanonicalJson(identity.receipt)
  )
    throw new Error("concept_selection_receipt_conflict");
  const p = parseCurrentConceptSelection(saved.pointer, digester),
    r = creativeStoreRecord(saved.receipt, ["idempotencyKey", "requestDigest"]);
  for (const [column, value] of Object.entries({
    tenant_id: identity.actor.tenantId,
    space_id: identity.actor.spaceId,
    principal_id: identity.actor.principalId,
    actor_id: identity.actor.actorId,
    idempotency_key: r.idempotencyKey,
    request_digest: r.requestDigest,
    project_id: p.projectId,
    asset_id: p.assetId,
    result_link_digest: p.resultLinkDigest,
  }))
    same(row[column], value);
  same(saved.resultLinkDigest, p.resultLinkDigest);
  return saved;
}
export function* loadConceptSelectionReceiptPlan(
  d: SelectionDialect,
  identity: ReturnType<typeof captureConceptSelectionReceipt>,
): SelectionPlan<CommitProjectConceptSelectionResult | null> {
  const saved = yield* receipt(d, identity);
  if (!saved) return null;
  const p = parseCurrentConceptSelection(saved.pointer, digester),
    link = yield* linkedResult(d, ownerFor(identity.actor), p);
  return Object.freeze({
    disposition: "replayed",
    pointer: p,
    resultLink: link,
  });
}
function* source(
  d: SelectionDialect,
  actor: ActorContext,
  reference: { projectId: string; assetId: string; assetRevision: number },
  operationId: string,
  operationRevision: number,
  verifier: ProjectGenerationImageResultVerifier,
  resultIndex: number,
): SelectionPlan<OperationResultLink> {
  const owner = ownerFor(actor),
    locator = { owner, ...reference },
    rows = yield* query(
      d,
      projectGenerationSourceReadSql(d.prefix, true),
      projectGenerationSourceValues(locator),
    ),
    link = decodeProjectGenerationSource(rows, locator);
  if (!link || link.binding.source !== null)
    throw new Error("concept_selection_generation_missing");
  const historical = yield* historicalSource(d, owner, reference);
  if (
    historical.revision.contentDigest !== link.assetContentDigest ||
    historical.brief.contentDigest !== link.briefContentDigest ||
    historical.brief.briefRevision !== link.briefRevision ||
    digester.sha256(
      extensionCanonicalJson({ prompt: historical.revision.prompt }),
    ) !== link.binding.inputDigest
  )
    throw new Error("concept_selection_source_proof_changed");
  const admissionRows = yield* query(d, admissionQuery(d.prefix), [
      actor.tenantId,
      actor.spaceId,
      link.binding.runId,
    ]),
    admission = decodePluginTaskAdmissionRecord(admissionRows[0]);
  if (
    !admission ||
    admission.principalId !== actor.principalId ||
    admission.extensionBindingDigest !== link.binding.bindingDigest ||
    admission.actorId !== link.receipt.actorId ||
    admission.idempotencyKey !== link.receipt.idempotencyKey ||
    admission.requestDigest !== link.receipt.requestDigest
  )
    throw new Error("concept_selection_paid_proof_invalid");
  assertPluginTaskAdmission(
    { admission, binding: link.binding, receipt: link.receipt },
    digester,
  );
  const originalReceipt = parseExtensionTurnReceipt(
    jsonRecord(rows[0]?.stored_result_json),
    link.binding,
    link.receipt,
  );
  assertPluginTaskFunding(
    {
      creditAdmission: originalReceipt.creditAdmission,
      unmeteredAdmission: originalReceipt.unmeteredAdmission,
      binding: link.binding,
      receipt: link.receipt,
      principalId: actor.principalId,
      task: admission,
    },
    digester,
  );
  if (originalReceipt.unmeteredAdmission !== undefined) {
    const proofRows = yield* query(
      d,
      `SELECT * FROM ${d.prefix}plugin_task_unmetered_admissions WHERE tenant_id=$1 AND space_id=$2 AND run_id=$3`,
      [actor.tenantId, actor.spaceId, link.binding.runId],
    );
    const row = proofRows[0];
    const proof = decodePluginTaskUnmeteredRecord(
      row === undefined
        ? undefined
        : { ...row, task_json: admission, binding_json: link.binding },
    );
    assertUnmeteredReceipt(originalReceipt, proof);
  } else {
    const creditRows = yield* query(
      d,
      `SELECT * FROM ${d.prefix}extension_credit_admissions WHERE tenant_id=$1 AND run_id=$2`,
      [actor.tenantId, link.binding.runId],
    );
    const credit = decodeExtensionCreditAdmission(
      creditRows[0] as Parameters<typeof decodeExtensionCreditAdmission>[0],
    );
    if (!credit || credit.reservation.scope.principalId !== actor.principalId)
      throw new Error("concept_selection_paid_proof_invalid");
    assertExtensionCreditAdmission(
      { admission: credit, binding: link.binding, receipt: link.receipt },
      digester,
    );
    if (
      extensionCanonicalJson(originalReceipt.creditAdmission) !==
      extensionCanonicalJson(credit)
    )
      throw new Error("concept_selection_paid_proof_invalid");
  }
  const configRows = yield* query(
      d,
      `SELECT * FROM ${d.prefix}extension_configurations WHERE tenant_id=$1 AND space_id=$2 AND plugin_id=$3 AND revision=$4`,
      [
        actor.tenantId,
        actor.spaceId,
        link.binding.pluginId,
        link.binding.configurationRevision,
      ],
    ),
    row = configRows[0],
    configuration = parseExtensionConfiguration(
      jsonRecord(row?.configuration_json),
      digester,
    );
  for (const [column, value] of Object.entries({
    tenant_id: configuration.tenantId,
    space_id: configuration.spaceId,
    plugin_id: configuration.pluginId,
    revision: configuration.revision,
  }))
    same(row?.[column], value);
  if (configuration.pluginVersion !== admission.version)
    throw new Error("concept_selection_configuration_invalid");
  const activationRows = yield* query(
      d,
      `SELECT * FROM ${d.prefix}extension_activations WHERE tenant_id=$1 AND space_id=$2 AND plugin_id=$3${d.postgres ? " FOR SHARE" : ""}`,
      [actor.tenantId, actor.spaceId, link.binding.pluginId],
    ),
    activationRow = activationRows[0],
    activation = parseExtensionActivation(
      jsonRecord(activationRow?.activation_json),
    );
  for (const [column, value] of Object.entries({
    tenant_id: activation.tenantId,
    space_id: activation.spaceId,
    plugin_id: activation.pluginId,
    revision: activation.revision,
    configuration_revision: activation.configurationRevision,
  }))
    same(activationRow?.[column], value);
  if (
    activation.tenantId !== actor.tenantId ||
    activation.spaceId !== actor.spaceId ||
    activation.pluginId !== link.binding.pluginId ||
    activation.state === "revoked"
  )
    throw new Error("extension_access_revoked");
  const operationRows = yield* query(
      d,
      `SELECT * FROM ${d.prefix}extension_external_operations WHERE tenant_id=$1 AND run_id=$2 AND binding_digest=$3 AND operation_id=$4${d.postgres ? " FOR UPDATE" : ""}`,
      [
        actor.tenantId,
        link.binding.runId,
        link.binding.bindingDigest,
        operationId,
      ],
    ),
    operationRow = operationRows[0],
    operation = parseExternalOperation(jsonRecord(operationRow?.record_json));
  for (const [column, value] of Object.entries({
    tenant_id: operation.tenantId,
    run_id: operation.runId,
    binding_digest: operation.bindingDigest,
    operation_id: operation.operationId,
    idempotency_key: operation.idempotencyKey,
    revision: operation.revision,
  }))
    same(operationRow?.[column], value);
  if (
    operation.tenantId !== actor.tenantId ||
    operation.runId !== link.binding.runId ||
    operation.bindingDigest !== link.binding.bindingDigest ||
    operation.operationId !== operationId
  )
    throw new Error("concept_selection_operation_conflict");
  if (operation.revision !== operationRevision)
    throw new Error("concept_selection_operation_revision_conflict");
  if (operation.status !== "succeeded" || operation.resultJson === null)
    throw new Error("concept_selection_operation_not_succeeded");
  const image = verifyProjectGenerationImage(verifier, {
    generationLink: link,
    configuration,
    operation,
    resultIndex,
  });
  return createOperationResultLink(
    {
      actor,
      generationLink: link,
      configuration,
      packageDigest: admission.packageDigest,
      operation: {
        operationId,
        operationRevision,
        operationDigest: digester.sha256(extensionCanonicalJson(operation)),
        rawResultDigest: digester.sha256(operation.resultJson),
        observedAt: operation.updatedAt,
      },
      image,
    },
    digester,
  );
}
function* metadata(
  d: SelectionDialect,
  owner: CreativeProjectOwnerScope,
  projectId: string,
  assetId: string,
) {
  const p = yield* query(
      d,
      `SELECT * FROM ${d.prefix}creative_projects WHERE tenant_id=$1 AND space_id=$2 AND owner_principal_id=$3 AND project_id=$4`,
      [...ownerValues(owner), projectId],
    ),
    project = decodeCreativeProject(p[0], owner, projectId);
  if (!project) throw new Error("creative_project_not_found");
  const a = yield* query(
      d,
      `SELECT a.*,p.owner_principal_id FROM ${d.prefix}creative_concept_assets a JOIN ${d.prefix}creative_projects p ON p.tenant_id=a.tenant_id AND p.space_id=a.space_id AND p.project_id=a.project_id WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3 AND p.project_id=$4 AND a.asset_id=$5`,
      [...ownerValues(owner), projectId, assetId],
    ),
    asset = decodeCreativeAsset(a[0], owner, projectId);
  if (!asset || asset.assetId !== assetId)
    throw new Error("creative_project_asset_not_found");
  return { project, asset };
}
function* historicalSource(
  d: SelectionDialect,
  owner: CreativeProjectOwnerScope,
  reference: { projectId: string; assetId: string; assetRevision: number },
) {
  const r = yield* query(
      d,
      `SELECT r.*,p.owner_principal_id FROM ${d.prefix}creative_concept_revisions r JOIN ${d.prefix}creative_projects p ON p.tenant_id=r.tenant_id AND p.space_id=r.space_id AND p.project_id=r.project_id WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3 AND p.project_id=$4 AND r.asset_id=$5 AND r.asset_revision=$6`,
      [
        ...ownerValues(owner),
        reference.projectId,
        reference.assetId,
        reference.assetRevision,
      ],
    ),
    revision = decodeCreativeRevision(
      r[0],
      owner,
      reference.projectId,
      reference.assetId,
    );
  if (!revision) throw new Error("creative_project_asset_revision_not_found");
  const b = yield* query(
      d,
      `SELECT b.*,p.owner_principal_id FROM ${d.prefix}creative_project_briefs b JOIN ${d.prefix}creative_projects p ON p.tenant_id=b.tenant_id AND p.space_id=b.space_id AND p.project_id=b.project_id WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3 AND p.project_id=$4 AND b.brief_revision=$5`,
      [...ownerValues(owner), reference.projectId, revision.briefRevision],
    ),
    brief = decodeCreativeBrief(b[0], owner, reference.projectId);
  if (!brief) throw new Error("creative_project_brief_not_found");
  return { revision, brief };
}
function* freshSource(
  d: SelectionDialect,
  input: CommitProjectConceptSelectionInput,
) {
  const owner = ownerFor(input.actor),
    { project, asset } = yield* metadata(
      d,
      owner,
      input.reference.projectId,
      input.reference.assetId,
    );
  const { revision, brief } = yield* historicalSource(
    d,
    owner,
    input.reference,
  );
  validateProjectGenerationSource(
    {
      actor: input.actor,
      reference: input.reference,
      project,
      asset,
      assetRevision: revision,
      brief,
    },
    digester,
  );
}
export function* commitConceptSelectionPlan(
  d: SelectionDialect,
  prepared: PreparedConceptSelection,
  verifier: ProjectGenerationImageResultVerifier,
): SelectionPlan<CommitProjectConceptSelectionResult> {
  const { input } = prepared,
    owner = ownerFor(input.actor),
    identity = captureConceptSelectionReceipt({
      actor: input.actor,
      receipt: input.receipt,
    });
  yield* lock(d, [
    "concept-selection-receipt",
    d.schema,
    ...ownerValues(owner),
    input.actor.actorId,
    input.receipt.idempotencyKey,
  ]);
  const previous = yield* receipt(d, identity);
  yield* lock(d, [
    "creative-project-project",
    d.schema,
    input.actor.tenantId,
    input.actor.spaceId,
    input.reference.projectId,
  ]);
  if (previous) {
    if (
      extensionCanonicalJson(previous.request) !==
        extensionCanonicalJson(request(input)) ||
      extensionCanonicalJson(previous.sourceIdentity) !==
        extensionCanonicalJson(sourceIdentity(prepared.source))
    )
      throw new Error("concept_selection_receipt_conflict");
    const p = parseCurrentConceptSelection(previous.pointer, digester),
      saved = yield* linkedResult(d, owner, p),
      actual = yield* source(
        d,
        input.actor,
        p.reference,
        saved.operationId,
        saved.operationRevision,
        verifier,
        saved.image.resultIndex,
      );
    if (extensionCanonicalJson(actual) !== extensionCanonicalJson(saved))
      throw new Error("concept_selection_result_proof_changed");
    return Object.freeze({
      disposition: "replayed",
      pointer: p,
      resultLink: saved,
    });
  }
  yield* freshSource(d, input);
  const link = yield* source(
      d,
      input.actor,
      input.reference,
      input.operationId,
      input.expectedOperationRevision,
      verifier,
      input.resultIndex,
    ),
    current = yield* pointer(
      d,
      owner,
      input.reference.projectId,
      input.reference.assetId,
    ),
    selected = createCurrentConceptSelection(
      {
        actor: input.actor,
        resultLink: link,
        previous: current,
        expectedSelectionRevision: input.expectedSelectionRevision,
        at: input.at,
      },
      digester,
    );
  yield* query(
    d,
    `INSERT INTO ${d.prefix}${linkTable}(tenant_id,space_id,project_id,owner_principal_id,asset_id,asset_revision,source_run_id,source_binding_digest,operation_id,operation_revision,result_index,content_digest,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
    [
      link.tenantId,
      link.spaceId,
      link.projectId,
      link.ownerPrincipalId,
      link.reference.assetId,
      link.reference.assetRevision,
      link.sourceRunId,
      link.sourceBindingDigest,
      link.operationId,
      link.operationRevision,
      link.image.resultIndex,
      link.contentDigest,
      extensionCanonicalJson(link),
    ],
  );
  const storedLink = yield* linkedResult(d, owner, selected);
  if (extensionCanonicalJson(storedLink) !== extensionCanonicalJson(link))
    throw new Error("concept_selection_result_conflict");
  const pointerValues = [
    selected.tenantId,
    selected.spaceId,
    selected.projectId,
    selected.ownerPrincipalId,
    selected.assetId,
    selected.selectionRevision,
    selected.resultLinkDigest,
    extensionCanonicalJson(selected),
  ];
  if (!current)
    yield* query(
      d,
      `INSERT INTO ${d.prefix}${pointerTable}(tenant_id,space_id,project_id,owner_principal_id,asset_id,selection_revision,result_link_digest,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      pointerValues,
    );
  else {
    const updated = yield* query(
      d,
      `UPDATE ${d.prefix}${pointerTable} SET selection_revision=$6,result_link_digest=$7,record_json=$8 WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 AND owner_principal_id=$4 AND asset_id=$5 AND selection_revision=$9 RETURNING selection_revision`,
      [...pointerValues, current.selectionRevision],
    );
    if (updated.length !== 1)
      throw new Error("concept_selection_revision_conflict");
    same(updated[0]?.selection_revision, selected.selectionRevision);
  }
  const body = {
      schemaVersion: "crewon.concept-selection-receipt.v1",
      actor: input.actor,
      receipt: input.receipt,
      request: request(input),
      sourceIdentity: sourceIdentity(prepared.source),
      pointer: selected,
      resultLinkDigest: link.contentDigest,
    },
    record = {
      ...body,
      contentDigest: digester.sha256(extensionCanonicalJson(body)),
    };
  yield* query(
    d,
    `INSERT INTO ${d.prefix}${receiptTable}(tenant_id,space_id,principal_id,actor_id,idempotency_key,request_digest,project_id,asset_id,result_link_digest,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      input.actor.tenantId,
      input.actor.spaceId,
      input.actor.principalId,
      input.actor.actorId,
      input.receipt.idempotencyKey,
      input.receipt.requestDigest,
      selected.projectId,
      selected.assetId,
      selected.resultLinkDigest,
      extensionCanonicalJson(record),
    ],
  );
  return Object.freeze({
    disposition: "committed",
    pointer: selected,
    resultLink: link,
  });
}
export function* loadCurrentConceptSelectionPlan(
  d: SelectionDialect,
  input: ReturnType<typeof captureConceptSelectionRead>,
): SelectionPlan<CurrentConceptSelectionReadResult> {
  yield* metadata(d, input.owner, input.projectId, input.assetId);
  const p = yield* pointer(d, input.owner, input.projectId, input.assetId);
  if (!p) return Object.freeze({ selectionRevision: 0, current: null });
  const link = yield* linkedResult(d, input.owner, p);
  return Object.freeze({
    selectionRevision: p.selectionRevision,
    current: Object.freeze({ pointer: p, resultLink: link }),
  });
}
