import { types } from "node:util";
import { projectAssetInstallationEvidence } from "./project-asset-qualification-data.ts";
import {
  projectAssetId,
  projectAssetDigest,
  projectAssetRevision,
  projectAssetTimestamp,
  pluginInstallationVersion,
} from "@crewon/domain";
import { materialPreparationFields as fields } from "./project-material-preparation-record.ts";
import {
  mediaInputData,
  mediaInputActor,
  mediaInputDigest,
  mediaInputSame,
  parseProjectMediaWorkflow,
} from "./project-media-input-record.ts";
import { parseProjectMediaGenerationReference } from "./project-media-generation-record.ts";
import { ApplicationError } from "./application-error.ts";
import type {
  ProjectMediaResultRequest,
  ProjectMediaResultSource,
  FrozenProjectMediaResult,
  ProjectMediaResultCandidate,
  ProjectMediaResultAuthority,
  ProjectMediaResultUiInstallation,
} from "./project-media-result-port.ts";

export function mediaResultFail(code: string): never {
  throw new ApplicationError(
    code === "denied"
      ? "authorization"
      : code === "not_found"
        ? "notFound"
        : code === "conflict"
          ? "conflict"
          : "internal",
    `project_media_result_${code}`,
  );
}
export function parseProjectMediaResultRequest(
  input: unknown,
): ProjectMediaResultRequest {
  const r = fields(mediaInputData(input, 2048), ["actor", "query"]),
    q = fields(r.query, ["projectId", "runId", "resultIndex"]);
  if (
    !Number.isSafeInteger(q.resultIndex) ||
    (q.resultIndex as number) < 0 ||
    (q.resultIndex as number) > 15
  )
    mediaResultFail("query_invalid");
  return Object.freeze({
    actor: mediaInputActor(r.actor),
    query: Object.freeze({
      projectId: projectAssetId(q.projectId),
      runId: projectAssetId(q.runId),
      resultIndex: q.resultIndex as number,
    }),
  });
}
export function parseProjectMediaResultImage(input: unknown, origin: string) {
  const i = fields(input, ["filename", "subfolder", "type", "url"]);
  if (
    typeof i.filename !== "string" ||
    !i.filename ||
    i.filename.length > 255 ||
    i.filename.trim() !== i.filename ||
    /[\\/\[\]:\u0000-\u001f\u007f\ud800-\udfff]/u.test(i.filename) ||
    [".", ".."].includes(i.filename) ||
    typeof i.subfolder !== "string" ||
    i.subfolder.length > 512 ||
    i.subfolder.trim() !== i.subfolder ||
    /[\\\[\]:\u0000-\u001f\u007f\ud800-\udfff]/u.test(i.subfolder) ||
    i.subfolder.startsWith("/") ||
    i.subfolder
      .split("/")
      .some((p) => p === "." || p === ".." || (!p && i.subfolder !== "")) ||
    i.type !== "output"
  )
    mediaResultFail("image_invalid");
  const ref = {
    filename: i.filename,
    subfolder: i.subfolder,
    type: "output" as const,
  };
  const url = new URL("/view?" + new URLSearchParams(ref), origin).href;
  if (i.url !== url) mediaResultFail("image_invalid");
  return Object.freeze({ ...ref, url });
}
export function parseProjectMediaResultSource(
  input: unknown,
): ProjectMediaResultSource {
  const r = fields(mediaInputData(input, 16384), [
      "schemaVersion",
      "request",
      "reference",
      "item",
      "workflow",
      "targetIdentity",
      "configuration",
      "generationDigest",
      "operationLinkDigest",
      "operation",
      "image",
      "contentDigest",
    ]),
    t = fields(r.targetIdentity, [
      "pluginId",
      "version",
      "publisherId",
      "packageDigest",
      "manifestDigest",
      "implementationDigest",
    ]),
    c = fields(r.configuration, ["revision", "contentDigest", "origin"]),
    o = fields(r.operation, [
      "operationId",
      "providerOperationId",
      "revision",
      "contentDigest",
    ]);
  if (
    r.schemaVersion !== "crewon.project-media-result-source.v1" ||
    t.pluginId !== "crewon.short-drama" ||
    typeof c.origin !== "string"
  )
    mediaResultFail("source_invalid");
  const origin = new URL(c.origin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.href !== c.origin
  )
    mediaResultFail("origin_invalid");
  const request = parseProjectMediaResultRequest(r.request),
    reference = parseProjectMediaGenerationReference(r.reference),
    workflow = parseProjectMediaWorkflow(r.workflow),
    itemRaw = fields(
      r.item,
      workflow.workflowId === "krea2-reference-four-view"
        ? ["kind", "assetId"]
        : ["kind", "episodeId"],
    );
  const item =
    workflow.workflowId === "krea2-reference-four-view"
      ? {
          kind: "character-reference" as const,
          assetId: projectAssetId(itemRaw.assetId),
        }
      : {
          kind: "storyboard-frame-exploration" as const,
          episodeId: projectAssetId(itemRaw.episodeId),
        };
  if (
    itemRaw.kind !== item.kind ||
    request.query.projectId !== reference.projectId ||
    reference.workflowId !== workflow.workflowId
  )
    mediaResultFail("source_invalid");
  const uuid = (v: unknown) => {
    if (
      typeof v !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v)
    )
      mediaResultFail("source_invalid");
    return v;
  };
  const body = {
    schemaVersion: "crewon.project-media-result-source.v1" as const,
    request,
    reference,
    item: Object.freeze(item),
    workflow,
    targetIdentity: Object.freeze({
      pluginId: "crewon.short-drama" as const,
      version: pluginInstallationVersion(t.version),
      publisherId: projectAssetId(t.publisherId),
      packageDigest: projectAssetDigest(t.packageDigest),
      manifestDigest: projectAssetDigest(t.manifestDigest),
      implementationDigest: projectAssetDigest(t.implementationDigest),
    }),
    configuration: Object.freeze({
      revision: projectAssetRevision(c.revision),
      contentDigest: projectAssetDigest(c.contentDigest),
      origin: origin.href,
    }),
    generationDigest: projectAssetDigest(r.generationDigest),
    operationLinkDigest: projectAssetDigest(r.operationLinkDigest),
    operation: Object.freeze({
      operationId: uuid(o.operationId),
      providerOperationId: uuid(o.providerOperationId),
      revision: projectAssetRevision(o.revision),
      contentDigest: projectAssetDigest(o.contentDigest),
    }),
    image: parseProjectMediaResultImage(r.image, origin.href),
  };
  if (r.contentDigest !== mediaInputDigest(body))
    mediaResultFail("source_invalid");
  return Object.freeze({
    ...body,
    contentDigest: projectAssetDigest(r.contentDigest),
  });
}
export function projectMediaResultArchiveIdentity(
  request: ProjectMediaResultRequest,
  archiveId: string,
) {
  const r = parseProjectMediaResultRequest(request),
    id = projectAssetId(archiveId);
  return Object.freeze({
    materialId:
      "pr-" + mediaInputDigest({ archiveId: id, request: r }).slice(7),
    requestDigest: mediaInputDigest(r),
  });
}
export function parseFrozenProjectMediaResult(
  input: unknown,
): FrozenProjectMediaResult {
  const r = fields(mediaInputData(input, 24576), [
      "schemaVersion",
      "archiveId",
      "materialId",
      "requestDigest",
      "request",
      "source",
    ]),
    s = fields(r.source, [
      "projection",
      "byteDigest",
      "byteLength",
      "width",
      "height",
      "mediaType",
      "observedAt",
    ]),
    request = parseProjectMediaResultRequest(r.request),
    archiveId = projectAssetId(r.archiveId),
    identity = projectMediaResultArchiveIdentity(request, archiveId),
    projection = parseProjectMediaResultSource(s.projection);
  if (
    r.schemaVersion !== "crewon.project-media-result-frozen.v1" ||
    r.materialId !== identity.materialId ||
    r.requestDigest !== identity.requestDigest ||
    !mediaInputSame(projection.request, request) ||
    s.mediaType !== "image/png" ||
    !Number.isSafeInteger(s.byteLength) ||
    (s.byteLength as number) < 57 ||
    (s.byteLength as number) > 16 * 1024 * 1024 ||
    !Number.isSafeInteger(s.width) ||
    !Number.isSafeInteger(s.height) ||
    (s.width as number) < 1 ||
    (s.height as number) < 1 ||
    (s.width as number) > 4096 ||
    (s.height as number) > 4096
  )
    mediaResultFail("frozen_invalid");
  return Object.freeze({
    schemaVersion: "crewon.project-media-result-frozen.v1",
    archiveId,
    ...identity,
    request,
    source: Object.freeze({
      projection,
      byteDigest: projectAssetDigest(s.byteDigest),
      byteLength: s.byteLength as number,
      width: s.width as number,
      height: s.height as number,
      mediaType: "image/png",
      observedAt: projectAssetTimestamp(s.observedAt),
    }),
  });
}
export const frozenProjectMediaResultFingerprint = (
  input: FrozenProjectMediaResult,
) => {
  const record = parseFrozenProjectMediaResult(input);
  const { observedAt: _observedAt, ...source } = record.source;
  // Concurrent observations of identical bytes use the first durable timestamp.
  return mediaInputDigest({ ...record, source });
};
export function createProjectMediaResultCandidate(
  frozen: FrozenProjectMediaResult,
): ProjectMediaResultCandidate {
  const record = parseFrozenProjectMediaResult(frozen),
    body = {
      schemaVersion: "crewon.project-media-result-candidate.v1" as const,
      candidateId: "result-" + mediaInputDigest(record.request).slice(7),
      frozen: record,
    };
  return Object.freeze({ ...body, contentDigest: mediaInputDigest(body) });
}
export function parseProjectMediaResultCandidate(
  input: unknown,
): ProjectMediaResultCandidate {
  const r = fields(mediaInputData(input, 32768), [
      "schemaVersion",
      "candidateId",
      "frozen",
      "contentDigest",
    ]),
    expected = createProjectMediaResultCandidate(
      parseFrozenProjectMediaResult(r.frozen),
    );
  if (!mediaInputSame(r, expected)) mediaResultFail("candidate_invalid");
  return expected;
}
export function captureProjectMediaResultAuthority(
  input: ProjectMediaResultAuthority,
  request: ProjectMediaResultRequest,
  action: "read" | "publish",
) {
  if (types.isProxy(input)) mediaResultFail("authority_invalid");
  const a = fields(input, [
    ...(Object.hasOwn(input, "uiInstallation") ? ["uiInstallation"] : []),
    "request",
    "action",
    "assertCurrent",
    "assertActive",
  ]);
  if (
    !mediaInputSame(parseProjectMediaResultRequest(a.request), request) ||
    a.action !== action ||
    typeof a.assertCurrent !== "function" ||
    typeof a.assertActive !== "function"
  )
    mediaResultFail("authority_invalid");
  return Object.freeze({
    request,
    action,
    ...(a.uiInstallation === undefined
      ? {}
      : {
          uiInstallation: captureProjectMediaResultUiInstallation(
            a.uiInstallation,
            request.actor,
          ),
        }),
    assertCurrent: async () =>
      projectMediaResultAssertVoid(
        await Reflect.apply(a.assertCurrent as Function, input, []),
      ),
    assertActive: () =>
      projectMediaResultAssertVoid(
        Reflect.apply(a.assertActive as Function, input, []),
      ),
  });
}
export function projectMediaResultAssertVoid(result: unknown): void {
  if (result === undefined) return;
  try {
    void Promise.prototype.then.call(
      result,
      () => undefined,
      () => undefined,
    );
  } catch {
    /* Do not inspect arbitrary thenables. */
  }
  mediaResultFail("authority_invalid");
}

export function captureProjectMediaResultUiInstallation(
  input: unknown,
  actor: ProjectMediaResultRequest["actor"],
): ProjectMediaResultUiInstallation {
  const f = fields(mediaInputData(input, 65536), [
    "installation",
    "selection",
    "package",
  ]);
  const evidence = projectAssetInstallationEvidence({ ...f, actor });
  if (evidence.installation.pluginId !== "crewon.short-drama")
    mediaResultFail("authority_invalid");
  return Object.freeze({
    installation: evidence.installation,
    selection: evidence.selection,
    package: evidence.package,
  });
}
