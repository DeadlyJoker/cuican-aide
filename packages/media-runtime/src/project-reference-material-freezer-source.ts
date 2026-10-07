import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  ApplicationError,
  ProjectAssetReferenceImageApplicationService,
  ProjectAssetMediaReferenceImageApplicationService,
  parseFrozenProjectReferenceMaterial,
  projectReferenceMaterialFreezeIdentity,
  createFrozenProjectAdoptedMediaMaterial,
  assertFrozenProjectAdoptedMediaSource,
  type ActorContext,
  type ProjectAssetReferenceImageQuery,
  type ProjectAssetReferenceImageSource,
  type ProjectAssetMediaReferenceImageSource,
  type ProjectReferenceMaterialFreezeRequest,
  type FrozenProjectReferenceMaterial,
  type FrozenProjectReferenceMaterialContent,
  type ProjectReferenceMaterialFreezeAuthorizationPort,
  type ProjectAdoptedMediaMaterialFreezeAuthorizationPort,
} from "@crewon/application";
import { ProjectReferenceMaterialReader } from "./project-reference-material-reader.ts";
import { ProjectAdoptedMediaReferenceReader } from "./project-adopted-media-reference-reader.ts";
import { materialPreparationBound as bound } from "./project-material-preparation-support.ts";
const digester = {
  sha256: (text: string) =>
    `sha256:${createHash("sha256").update(text).digest("hex")}`,
};
export type ProjectReferenceFreezeSourceInput =
  | Readonly<{
      sourceKind?: "concept";
      sources: ProjectAssetReferenceImageApplicationService;
      reader: ProjectReferenceMaterialReader;
      authorization: ProjectReferenceMaterialFreezeAuthorizationPort;
    }>
  | Readonly<{
      sourceKind: "media-result";
      sources: ProjectAssetMediaReferenceImageApplicationService;
      reader: ProjectAdoptedMediaReferenceReader;
      authorization: ProjectAdoptedMediaMaterialFreezeAuthorizationPort;
    }>;
type Snapshot =
  | Readonly<{ kind: "concept"; value: ProjectAssetReferenceImageSource }>
  | Readonly<{
      kind: "media-result";
      value: ProjectAssetMediaReferenceImageSource;
    }>;
type Driver = Readonly<{
  resolve(
    actor: ActorContext,
    query: ProjectAssetReferenceImageQuery,
    signal: AbortSignal,
  ): Promise<Snapshot>;
  read(
    request: ProjectReferenceMaterialFreezeRequest,
    archiveId: string,
    signal: AbortSignal,
  ): Promise<FrozenProjectReferenceMaterialContent>;
  assertSource(record: FrozenProjectReferenceMaterial, source: Snapshot): void;
  grant(
    request: ProjectReferenceMaterialFreezeRequest,
    source: Snapshot,
    archiveId: string,
    signal: AbortSignal,
  ): Promise<void>;
}>;
/** Capture actual service methods once; callers never inject source records or execution callbacks. */
export function captureProjectReferenceFreezeSource(
  input: ProjectReferenceFreezeSourceInput,
): Driver {
  if (
    types.isProxy(input.sources) ||
    types.isProxy(input.reader) ||
    types.isProxy(input.authorization)
  )
    fail("dependency_invalid");
  if (input.sourceKind === "media-result") {
    if (
      !(
        input.sources instanceof
        ProjectAssetMediaReferenceImageApplicationService
      ) ||
      !(input.reader instanceof ProjectAdoptedMediaReferenceReader)
    )
      fail("dependency_invalid");
    const resolve =
        ProjectAssetMediaReferenceImageApplicationService.prototype.resolveSelectedReference.bind(
          input.sources,
        ),
      read =
        ProjectAdoptedMediaReferenceReader.prototype.readSelectedReferenceBytes.bind(
          input.reader,
        ),
      authorize = bound<
        ProjectAdoptedMediaMaterialFreezeAuthorizationPort["authorize"]
      >(input.authorization, "authorize");
    return Object.freeze({
      resolve: async (actor, query, signal) =>
        Object.freeze({
          kind: "media-result",
          value: await resolve(actor, query, { signal }),
        }),
      read: async (request, archiveId, signal) => {
        const content = await read(request.actor, request.query, { signal });
        return Object.freeze({
          record: createFrozenProjectAdoptedMediaMaterial(
            request,
            archiveId,
            content.source,
            digester,
          ),
          bytes: content.bytes,
        });
      },
      assertSource: (record, source) => {
        if (
          source.kind !== "media-result" ||
          record.schemaVersion !== "crewon.project-reference-frozen-material.v2"
        )
          fail("source_changed");
        assertFrozenProjectAdoptedMediaSource(record, source.value, digester);
      },
      grant: async (request, source, archiveId, signal) => {
        if (source.kind !== "media-result") fail("source_changed");
        signal.throwIfAborted();
        const identity = projectReferenceMaterialFreezeIdentity(
            request,
            archiveId,
            digester,
          ),
          decision = await authorize(
            Object.freeze({
              actor: request.actor,
              action: "projectReferenceMaterial:freeze",
              resource: Object.freeze({
                sourceKind: "media-result",
                archiveId,
                materialId: identity.materialId,
                query: request.query,
                referenceDigest: source.value.reference.contentDigest,
                media: source.value.reference.source,
              }),
            }),
          );
        signal.throwIfAborted();
        if (decision.outcome !== "allow") denied();
      },
    } satisfies Driver);
  }
  if (
    (input.sourceKind !== undefined && input.sourceKind !== "concept") ||
    !(input.sources instanceof ProjectAssetReferenceImageApplicationService) ||
    !(input.reader instanceof ProjectReferenceMaterialReader)
  )
    fail("dependency_invalid");
  const resolve =
      ProjectAssetReferenceImageApplicationService.prototype.resolveSelectedReference.bind(
        input.sources,
      ),
    read =
      ProjectReferenceMaterialReader.prototype.readSelectedReferenceBytes.bind(
        input.reader,
      ),
    authorize = bound<
      ProjectReferenceMaterialFreezeAuthorizationPort["authorize"]
    >(input.authorization, "authorize");
  return Object.freeze({
    resolve: async (actor, query, signal) => {
      signal.throwIfAborted();
      const value = await resolve(actor, query);
      signal.throwIfAborted();
      return Object.freeze({ kind: "concept", value });
    },
    read: async (request, archiveId, signal) => {
      const content = await read(request.actor, request.query, { signal });
      return Object.freeze({
        record: parseFrozenProjectReferenceMaterial(
          {
            schemaVersion: "crewon.project-reference-frozen-material.v1",
            ...projectReferenceMaterialFreezeIdentity(
              request,
              archiveId,
              digester,
            ),
            request,
            source: content.observation,
          },
          digester,
        ),
        bytes: content.bytes,
      });
    },
    assertSource: (record, source) => {
      if (source.kind !== "concept") fail("source_changed");
      assertConceptSource(record, source.value);
    },
    grant: async (request, snapshot, archiveId, signal) => {
      if (snapshot.kind !== "concept") fail("source_changed");
      const source = snapshot.value,
        identity = projectReferenceMaterialFreezeIdentity(
          request,
          archiveId,
          digester,
        );
      signal.throwIfAborted();
      const decision = await authorize(
        Object.freeze({
          actor: request.actor,
          action: "projectReferenceMaterial:freeze",
          resource: Object.freeze({
            archiveId,
            materialId: identity.materialId,
            query: request.query,
            referenceDigest: source.reference.contentDigest,
            resultLinkDigest: source.resultLink.contentDigest,
            sourceBindingDigest: source.resultLink.sourceBindingDigest,
            packageDigest: source.resultLink.packageDigest,
            configurationDigest: source.configuration.contentDigest,
          }),
        }),
      );
      signal.throwIfAborted();
      if (decision.outcome !== "allow") denied();
    },
  } satisfies Driver);
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "project_reference_material_freeze_denied",
  );
}
function fail(code: string): never {
  throw new Error(`project_reference_material_freeze_${code}`);
}
function assertConceptSource(
  record: FrozenProjectReferenceMaterial,
  source: ProjectAssetReferenceImageSource,
): void {
  if (record.schemaVersion !== "crewon.project-reference-frozen-material.v1")
    fail("source_changed");
  const s = record.source,
    expected = {
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
    Object.entries(expected).some(
      ([key, value]) => s[key as keyof typeof s] !== value,
    ) ||
    s.output.filename !== source.resultLink.image.filename
  )
    fail("source_changed");
}
