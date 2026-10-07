import { captureProjectMediaInputRunCommitTransaction } from "./project-media-input-run-commit-authority.ts";
import { types } from "node:util";
import {
  extensionCanonicalJson,
  projectAssetId,
  projectAssetRevision,
  projectAssetDigest,
  projectAssetTimestamp,
  projectAssetText,
  validateCreativeProjectActor,
  pluginInstallationNamespaceId,
} from "@crewon/domain";
import { parseProjectAssetReferenceImageQuery } from "./project-asset-reference-image-store-port.ts";
import {
  materialPreparationFields as fields,
  materialPreparationDigester as hash,
  parseProjectMaterialPreparationTarget,
  parseProjectMaterialPreparationRequest,
} from "./project-material-preparation-record.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ProjectAssetReferenceImageSource } from "./project-asset-reference-image-store-port.ts";
import { parseProjectAssetMediaReferenceImageSource } from "./project-asset-media-reference-image.ts";
import {
  mediaInputReference,
  parseProjectMediaInputReference,
} from "./project-media-input-reference.ts";
import type {
  ProjectMediaRole,
  ProjectMediaInputSource,
  ProjectMediaWorkflowId,
  ProjectMediaItem,
  ProjectMediaWorkflow,
  ProjectMediaWorkflowReview,
  SaveProjectMediaInputCommand,
  ProjectMediaInputRevision,
  ProjectMediaInputWrite,
  ProjectMediaInputQuery,
  ProjectMediaInputAuthority,
} from "./project-media-input-port.ts";
export { mediaInputReference } from "./project-media-input-reference.ts";
export const MAX_PROJECT_MEDIA_INPUT_BYTES = 96 * 1024;
export const mediaInputSame = (a: unknown, b: unknown) =>
  extensionCanonicalJson(a) === extensionCanonicalJson(b);
export const mediaInputDigest = (v: unknown) =>
  hash.sha256(extensionCanonicalJson(v));
export function mediaInputActor(input: unknown): ActorContext {
  return validateCreativeProjectActor(
    fields(input, ["tenantId", "spaceId", "principalId", "actorId"]),
  );
}
export function mediaInputRoles(
  id: ProjectMediaWorkflowId,
): readonly ProjectMediaRole[] {
  if (id === "krea2-reference-four-view") return ["character"];
  if (id === "flux2-three-reference-storyboard")
    return ["scene", "characterOne", "characterTwo"];
  fail("workflow_invalid");
}
function workflowId(v: unknown): ProjectMediaWorkflowId {
  if (
    v !== "krea2-reference-four-view" &&
    v !== "flux2-three-reference-storyboard"
  )
    fail("workflow_invalid");
  return v;
}
function item(input: unknown, id: ProjectMediaWorkflowId): ProjectMediaItem {
  if (id === "krea2-reference-four-view") {
    const r = fields(input, ["kind", "assetId"]);
    if (r.kind !== "character-reference") fail("item_invalid");
    return Object.freeze({ kind: r.kind, assetId: projectAssetId(r.assetId) });
  }
  const r = fields(input, ["kind", "episodeId"]);
  if (r.kind !== "storyboard-frame-exploration") fail("item_invalid");
  return Object.freeze({
    kind: r.kind,
    episodeId: projectAssetId(r.episodeId),
  });
}
export function parseProjectMediaWorkflow(
  input: unknown,
): ProjectMediaWorkflow {
  const r = fields(input, ["workflowId", "workflowDigest", "output"]),
    id = workflowId(r.workflowId),
    o = fields(r.output, ["kind", "nodeId", "dimensions"]),
    nodeId = id === "krea2-reference-four-view" ? "129" : "17";
  if (
    o.kind !== "image" ||
    o.nodeId !== nodeId ||
    o.dimensions !== "workflow-native"
  )
    fail("workflow_invalid");
  return Object.freeze({
    workflowId: id,
    workflowDigest: projectAssetDigest(r.workflowDigest),
    output: Object.freeze({
      kind: "image",
      nodeId,
      dimensions: "workflow-native",
    }),
  });
}
export function parseProjectMediaWorkflowReview(
  input: unknown,
): ProjectMediaWorkflowReview {
  const r = fields(mediaInputData(input), ["targetIdentity", "workflow"]),
    t = fields(r.targetIdentity, [
      "pluginId",
      "version",
      "publisherId",
      "packageDigest",
      "manifestDigest",
      "implementationDigest",
    ]);
  if (
    t.pluginId !== "crewon.short-drama" ||
    typeof t.version !== "string" ||
    t.version.length > 32 ||
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(t.version)
  )
    fail("review_invalid");
  return Object.freeze({
    targetIdentity: Object.freeze({
      pluginId: t.pluginId,
      version: t.version,
      publisherId: pluginInstallationNamespaceId(t.publisherId),
      packageDigest: projectAssetDigest(t.packageDigest),
      manifestDigest: projectAssetDigest(t.manifestDigest),
      implementationDigest: projectAssetDigest(t.implementationDigest),
    }),
    workflow: parseProjectMediaWorkflow(r.workflow),
  });
}
export function parseSaveProjectMediaInputCommand(
  input: unknown,
): SaveProjectMediaInputCommand {
  const r = fields(mediaInputData(input), [
      "projectId",
      "mediaInputId",
      "expectedInputRevision",
      "item",
      "briefRevision",
      "script",
      "workflowId",
      "prompt",
      "references",
      "target",
      "idempotencyKey",
    ]),
    id = workflowId(r.workflowId),
    mediaItem = item(r.item, id),
    roles = mediaInputRoles(id),
    refs = fields(r.references, roles),
    projectId = projectAssetId(r.projectId),
    target = fields(r.target, [
      "profileId",
      "pluginId",
      "configurationRevision",
    ]);
  const references = Object.freeze(
    Object.fromEntries(
      roles.map((role) => {
        const q = parseProjectAssetReferenceImageQuery(refs[role]);
        if (
          q.projectId !== projectId ||
          q.kind !== (role === "scene" ? "scene" : "character")
        )
          fail("reference_invalid");
        return [role, q];
      }),
    ),
  );
  if (
    new Set(roles.map((role) => references[role]!.assetId)).size !==
      roles.length ||
    (mediaItem.kind === "character-reference" &&
      references.character!.assetId !== mediaItem.assetId)
  )
    fail("reference_invalid");
  let script: SaveProjectMediaInputCommand["script"] = null;
  if (r.script !== null) {
    const s = fields(r.script, ["artifactId", "contentRevision"]);
    script = Object.freeze({
      artifactId: projectAssetId(s.artifactId),
      contentRevision: projectAssetRevision(s.contentRevision),
    });
  }
  if (id === "flux2-three-reference-storyboard" && !script)
    fail("script_required");
  const mediaInputId =
      r.mediaInputId === null ? null : projectAssetId(r.mediaInputId),
    expectedInputRevision = projectAssetRevision(r.expectedInputRevision, 0);
  if ((mediaInputId === null) !== (expectedInputRevision === 0))
    fail("revision_invalid");
  if (target.pluginId !== "crewon.short-drama") fail("target_invalid");
  return Object.freeze({
    projectId,
    mediaInputId,
    expectedInputRevision,
    item: mediaItem,
    briefRevision: projectAssetRevision(r.briefRevision),
    script,
    workflowId: id,
    prompt: projectAssetText(r.prompt, 8192),
    references,
    target: Object.freeze({
      profileId: projectAssetId(target.profileId),
      pluginId: target.pluginId,
      configurationRevision: projectAssetRevision(target.configurationRevision),
    }),
    idempotencyKey: projectAssetId(r.idempotencyKey),
  });
}
export function mediaInputPreparationRequest(
  actor: ActorContext,
  command: SaveProjectMediaInputCommand,
  role: ProjectMediaRole,
  source: ProjectMediaInputSource,
  target: ProjectMediaInputRevision["target"],
) {
  const query = command.references[role]!;
  return parseProjectMaterialPreparationRequest({
    source: {
      actor,
      query,
      idempotencyKey: `media-freeze-${mediaInputDigest({ actor, query, sourceDigest: mediaInputDigest(source) }).slice(7)}`,
    },
    target: command.target,
    idempotencyKey: `media-prepare-${mediaInputDigest({ actor, query, sourceDigest: mediaInputDigest(source), target }).slice(7)}`,
  });
}
export function captureProjectMediaInputWrite(
  input: ProjectMediaInputWrite,
): ProjectMediaInputWrite {
  const r = fields(mediaInputData(input, 768 * 1024), [
      "actor",
      "command",
      "createdMediaInputId",
      "sources",
      "target",
      "workflow",
      "at",
    ]),
    actor = mediaInputActor(r.actor),
    command = parseSaveProjectMediaInputCommand(r.command),
    roles = mediaInputRoles(command.workflowId),
    a = r.sources;
  if (!Array.isArray(a) || a.length !== roles.length) fail("reference_invalid");
  const sources = a.map((v, index) => {
    const s = fields(v, ["role", "source"]);
    if (s.role !== roles[index]) fail("reference_invalid");
    if (
      s.source !== null &&
      typeof s.source === "object" &&
      Object.hasOwn(s.source, "candidate")
    ) {
      return Object.freeze({
        role: roles[index]!,
        source: parseProjectAssetMediaReferenceImageSource(s.source, {
          actor,
          query: command.references[roles[index]!]!,
        }),
      });
    }
    fields(s.source, [
      "asset",
      "content",
      "reference",
      "resultLink",
      "configuration",
    ]);
    return Object.freeze({
      role: roles[index]!,
      source: s.source as ProjectAssetReferenceImageSource,
    });
  });
  const request = parseProjectMaterialPreparationRequest({
      source: {
        actor,
        query: command.references[roles[0]!]!,
        idempotencyKey: "media-target-snapshot",
      },
      target: command.target,
      idempotencyKey: command.idempotencyKey,
    }),
    target = parseProjectMaterialPreparationTarget(r.target, request),
    workflow = parseProjectMediaWorkflow(r.workflow),
    createdMediaInputId =
      r.createdMediaInputId === null
        ? null
        : projectAssetId(r.createdMediaInputId);
  if (
    workflow.workflowId !== command.workflowId ||
    (command.mediaInputId === null
      ? createdMediaInputId === null
      : createdMediaInputId !== null)
  )
    fail("write_invalid");
  return Object.freeze({
    actor,
    command,
    createdMediaInputId,
    sources: Object.freeze(sources),
    target,
    workflow,
    at: projectAssetTimestamp(r.at),
  });
}
export function createProjectMediaInputRevision(
  input: ProjectMediaInputWrite,
  brief: ProjectMediaInputRevision["brief"],
  script: ProjectMediaInputRevision["script"],
) {
  const q = captureProjectMediaInputWrite(input),
    c = q.command,
    body = {
      schemaVersion: q.sources.some((s) => "candidate" in s.source)
        ? "crewon.project-media-input.v2"
        : "crewon.project-media-input.v1",
      actor: q.actor,
      projectId: c.projectId,
      mediaInputId: c.mediaInputId ?? q.createdMediaInputId!,
      inputRevision: c.expectedInputRevision + 1,
      item: c.item,
      brief,
      script,
      workflow: q.workflow,
      prompt: c.prompt,
      references: q.sources.map((s) =>
        mediaInputReference(
          s.role,
          s.source,
          mediaInputPreparationRequest(q.actor, c, s.role, s.source, q.target),
        ),
      ),
      target: q.target,
      createdAt: q.at,
    };
  return parseProjectMediaInputRevision({
    ...body,
    contentDigest: mediaInputDigest(body),
  });
}
export function parseProjectMediaInputRevision(
  input: unknown,
): ProjectMediaInputRevision {
  const r = fields(mediaInputData(input, MAX_PROJECT_MEDIA_INPUT_BYTES), [
      "schemaVersion",
      "actor",
      "projectId",
      "mediaInputId",
      "inputRevision",
      "item",
      "brief",
      "script",
      "workflow",
      "prompt",
      "references",
      "target",
      "createdAt",
      "contentDigest",
    ]),
    actor = mediaInputActor(r.actor),
    projectId = projectAssetId(r.projectId),
    workflow = parseProjectMediaWorkflow(r.workflow),
    roles = mediaInputRoles(workflow.workflowId),
    mediaItem = item(r.item, workflow.workflowId),
    b = fields(r.brief, ["briefRevision", "contentDigest"]);
  if (
    (r.schemaVersion !== "crewon.project-media-input.v1" &&
      r.schemaVersion !== "crewon.project-media-input.v2") ||
    !Array.isArray(r.references) ||
    r.references.length !== roles.length
  )
    fail("record_invalid");
  const references = r.references.map((v, index) =>
    parseProjectMediaInputReference(v, actor, projectId, roles[index]!),
  );
  const schemaVersion = references.some((r) => "media" in r)
    ? "crewon.project-media-input.v2"
    : "crewon.project-media-input.v1";
  if (r.schemaVersion !== schemaVersion) fail("record_invalid");

  if (
    new Set(references.map((x) => x.preparation.source.query.assetId)).size !==
      roles.length ||
    new Set(references.map((x) => x.preparation.idempotencyKey)).size !==
      roles.length ||
    (mediaItem.kind === "character-reference" &&
      mediaItem.assetId !== references[0]!.preparation.source.query.assetId)
  )
    fail("record_invalid");
  const target = parseProjectMaterialPreparationTarget(
    r.target,
    references[0]!.preparation,
  );
  if (workflow.workflowId === "flux2-three-reference-storyboard") {
    const one = references[1]!,
      two = references[2]!;
    if (
      one.sourceRunId === two.sourceRunId &&
      one.operationId === two.operationId &&
      one.resultIndex === two.resultIndex
    )
      fail("characters_duplicated");
  }
  if (
    references.some(
      (x) =>
        !mediaInputSame(
          x.preparation.target,
          references[0]!.preparation.target,
        ),
    )
  )
    fail("record_invalid");
  let script: ProjectMediaInputRevision["script"] = null;
  if (r.script !== null) {
    const s = fields(r.script, [
      "artifactId",
      "contentRevision",
      "contentDigest",
    ]);
    script = Object.freeze({
      artifactId: projectAssetId(s.artifactId),
      contentRevision: projectAssetRevision(s.contentRevision),
      contentDigest: projectAssetDigest(s.contentDigest),
    });
  }
  if (workflow.workflowId === "flux2-three-reference-storyboard" && !script)
    fail("script_required");
  const body: Omit<ProjectMediaInputRevision, "contentDigest"> = {
    schemaVersion,
    actor,
    projectId,
    mediaInputId: projectAssetId(r.mediaInputId),
    inputRevision: projectAssetRevision(r.inputRevision),
    item: mediaItem,
    brief: Object.freeze({
      briefRevision: projectAssetRevision(b.briefRevision),
      contentDigest: projectAssetDigest(b.contentDigest),
    }),
    script,
    workflow,
    prompt: projectAssetText(r.prompt, 8192),
    references: Object.freeze(references),
    target,
    createdAt: projectAssetTimestamp(r.createdAt),
  };
  if (r.contentDigest !== mediaInputDigest(body)) fail("digest_mismatch");
  return Object.freeze({ ...body, contentDigest: r.contentDigest });
}
export function parseProjectMediaInputQuery(
  input: unknown,
): ProjectMediaInputQuery {
  const r = fields(mediaInputData(input), [
    "actor",
    "projectId",
    "mediaInputId",
    "inputRevision",
  ]);
  return Object.freeze({
    actor: mediaInputActor(r.actor),
    projectId: projectAssetId(r.projectId),
    mediaInputId: projectAssetId(r.mediaInputId),
    inputRevision:
      r.inputRevision === null ? null : projectAssetRevision(r.inputRevision),
  });
}
export function captureProjectMediaInputAuthority(
  input: unknown,
  actor: ActorContext,
  projectId: string,
  action: ProjectMediaInputAuthority["action"],
): ProjectMediaInputAuthority {
  const a = fields(input, [
    "version",
    "actor",
    "projectId",
    "action",
    "review",
    "assertCurrent",
    "assertTransactionCurrent",
    "assertActive",
    ...(input !== null &&
    typeof input === "object" &&
    Object.hasOwn(input, "runTransaction")
      ? ["runTransaction"]
      : []),
  ]);
  if (
    a.version !== "crewon.project-media-input-commit.v1" ||
    !mediaInputSame(mediaInputActor(a.actor), actor) ||
    a.projectId !== projectId ||
    a.action !== action ||
    typeof a.assertCurrent !== "function" ||
    typeof a.assertTransactionCurrent !== "function" ||
    typeof a.assertActive !== "function" ||
    (action === "read" ? a.review !== null : a.review === null)
  )
    fail("authority_invalid");
  const runTransaction =
    a.runTransaction === undefined
      ? undefined
      : captureProjectMediaInputRunCommitTransaction(a.runTransaction);
  if (
    runTransaction !== undefined &&
    (action === "qualify" ||
      !mediaInputSame(runTransaction.actor, actor) ||
      runTransaction.mediaInputStageAdmission.projectId !== projectId)
  )
    fail("authority_invalid");
  return Object.freeze({
    version: a.version,
    actor,
    projectId,
    action,
    review:
      a.review === null ? null : parseProjectMediaWorkflowReview(a.review),
    assertCurrent: a.assertCurrent.bind(input),
    assertTransactionCurrent: a.assertTransactionCurrent.bind(input),
    assertActive: a.assertActive.bind(input),
    ...(runTransaction === undefined ? {} : { runTransaction }),
  });
}
export function assertProjectMediaInputActive(a: ProjectMediaInputAuthority) {
  a.runTransaction?.assertActive();
  const result: unknown = a.assertActive();
  if (result === undefined) return;
  try {
    void Promise.prototype.then.call(
      result,
      () => undefined,
      () => undefined,
    );
  } catch {
    /* No arbitrary thenable. */
  }
  fail("authority_invalid");
}
export async function assertProjectMediaInputCurrent(
  a: ProjectMediaInputAuthority,
  phase: "before" | "transaction",
) {
  if (
    (await (phase === "before"
      ? a.assertCurrent()
      : a.assertTransactionCurrent())) !== undefined
  )
    fail("authority_invalid");
  assertProjectMediaInputActive(a);
  if (a.runTransaction !== undefined) {
    await a.runTransaction.assertCurrent();
    assertProjectMediaInputActive(a);
  }
}
export function assertProjectMediaWorkflowReview(
  review: ProjectMediaWorkflowReview | null,
  record: Pick<ProjectMediaInputRevision, "workflow" | "target">,
) {
  if (!review || !mediaInputSame(review.workflow, record.workflow))
    fail("workflow_unreviewed");
  const t = record.target;
  if (
    !mediaInputSame(review.targetIdentity, {
      pluginId: t.package.pluginId,
      version: t.package.version,
      publisherId: t.package.publisherId,
      packageDigest: t.package.packageDigest,
      manifestDigest: t.configuration.manifestDigest,
      implementationDigest: t.configuration.implementationDigest,
    })
  )
    fail("workflow_unreviewed");
}
/** Descriptor-only bounded JSON capture, before any legacy parser or canonicalizer can run hooks. */
export function mediaInputData(input: unknown, maxBytes = 192 * 1024): unknown {
  let nodes = 0,
    bytes = 0;
  const ancestors = new WeakSet<object>();
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 32768 || depth > 32) fail("data_invalid");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      bytes += Buffer.byteLength(v);
      if (bytes > maxBytes) fail("data_invalid");
      return v;
    }
    if (!v || typeof v !== "object" || types.isProxy(v) || ancestors.has(v))
      fail("data_invalid");
    const p = Object.getPrototypeOf(v),
      ds = Object.getOwnPropertyDescriptors(v),
      keys = Reflect.ownKeys(ds);
    if (
      (Array.isArray(v)
        ? p !== Array.prototype
        : p !== Object.prototype && p !== null) ||
      keys.some((k) => typeof k !== "string") ||
      Object.values(ds).some((d) => !Object.hasOwn(d, "value"))
    )
      fail("data_invalid");
    ancestors.add(v);
    let result: unknown;
    if (Array.isArray(v)) {
      const length = ds.length?.value;
      if (
        !Number.isSafeInteger(length) ||
        length > 8192 ||
        keys.length !== length + 1
      )
        fail("data_invalid");
      result = Array.from({ length }, (_, i) => {
        const d = ds[String(i)];
        if (!d?.enumerable) fail("data_invalid");
        return visit(d.value, depth + 1);
      });
    } else {
      if (keys.length > 256 || Object.values(ds).some((d) => !d.enumerable))
        fail("data_invalid");
      result = Object.fromEntries(
        (keys as string[]).map((k) => [
          visit(k, depth + 1),
          visit(ds[k]!.value, depth + 1),
        ]),
      );
    }
    ancestors.delete(v);
    return Object.freeze(result);
  };
  const result = visit(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes)
    fail("data_invalid");
  return result;
}
export function projectMediaInputFail(code: string): never {
  fail(code);
}
function fail(code: string): never {
  throw new Error(`project_media_input_${code}`);
}
