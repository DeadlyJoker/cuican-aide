import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import {
  parseFrozenProjectReferenceMaterial,
  projectReferenceMaterialFreezeIdentity,
  type ProjectReferenceMaterialFreezeRequest,
} from "@crewon/application";
import { FilesystemProjectMaterialArchive } from "./filesystem-project-material-archive.ts";
export const materialArchiveDigester = {
  sha256: (text: string) =>
    `sha256:${createHash("sha256").update(text).digest("hex")}`,
};
/** Mechanical archive bytes only; caller-supplied metadata is never project provenance or a PNG check. */
export function materialArchiveInput(
  bytes = Buffer.alloc(1024, 47),
  idempotencyKey = "freeze-original",
) {
  const request: ProjectReferenceMaterialFreezeRequest = {
    actor: {
      tenantId: "tenant",
      spaceId: "space",
      principalId: "principal",
      actorId: "actor",
    },
    query: {
      projectId: "project",
      assetId: "character",
      kind: "character",
      expectedAssetRevision: 4,
      contentRevision: 1,
      referenceRevision: 1,
    },
    idempotencyKey,
  };
  const digest = materialArchiveDigester.sha256("named-proof-fixture");
  const record = parseFrozenProjectReferenceMaterial(
    {
      schemaVersion: "crewon.project-reference-frozen-material.v1",
      ...projectReferenceMaterialFreezeIdentity(
        request,
        "archive",
        materialArchiveDigester,
      ),
      request,
      source: {
        actor: request.actor,
        projectId: "project",
        assetId: "character",
        assetRevision: 4,
        contentRevision: 1,
        contentDigest: digest,
        referenceRevision: 1,
        referenceDigest: digest,
        resultLinkDigest: digest,
        sourceBindingDigest: digest,
        sourceRunId: "original-run",
        operationId: "original-operation",
        pluginId: "crewon.short-drama",
        pluginVersion: "20.0.2",
        packageDigest: digest,
        configurationRevision: 1,
        configurationDigest: digest,
        origin: "https://provider.example/",
        output: { filename: "original.png", subfolder: "", type: "output" },
        byteDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        byteLength: bytes.length,
        mediaType: "image/png",
        width: 2,
        height: 1,
        observedAt: "2026-10-06T08:00:00.000Z",
      },
    },
    materialArchiveDigester,
  );
  return { record, bytes };
}
export function materialArchiveFixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "crewon-material-archive-")),
    stores: FilesystemProjectMaterialArchive[] = [];
  const config = {
    archiveId: "archive",
    rootDirectory: root,
    encryptionKey: Buffer.alloc(32, 73),
    keyId: "named-test-key",
  };
  const open = (options: Partial<typeof config> = {}) => {
    const store = new FilesystemProjectMaterialArchive({
      ...config,
      ...options,
    });
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    config,
    open,
    blob: (materialId: string) => path.join(root, `${materialId}.crwpm`),
  };
}
