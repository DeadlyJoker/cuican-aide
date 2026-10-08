import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "./application-error.ts";
import { ProjectSourceUploadApplicationService } from "./project-source-upload-application-service.ts";
import { ProjectSourceUploadFoundationAdapter } from "./project-source-upload-foundation-adapter.ts";
import type { ProjectSourceUploadPermission } from "./project-source-upload-port.ts";
import type { ProjectSourcePreparationRequest } from "./project-source-preparation-port.ts";
import {
  sourceUploadFixture,
  uploadActor,
  uploadSha,
} from "./project-source-upload.test-support.ts";

test("bridge uses the actual upload adoption use case with independent PDP and the exact new/existing project target", async () => {
  // Actual Application services with a memory port; this does not establish SQL adoption.
  const f = sourceUploadFixture(),
    permissions: ProjectSourceUploadPermission[] = [],
    service = new ProjectSourceUploadApplicationService({
      ...f.dependencies,
      authorization: {
        async authorize(permission) {
          permissions.push(permission);
          return f.dependencies.authorization.authorize(permission);
        },
        assertActive(permission) {
          return f.dependencies.authorization.assertActive(permission);
        },
      },
    }),
    bridge = new ProjectSourceUploadFoundationAdapter(service),
    bytes = new TextEncoder().encode("原文😀\r\n故事"),
    fileDigest = uploadSha(bytes),
    begun = await service.begin(uploadActor, {
      idempotencyKey: "bridge-file",
      fileName: "story.txt",
      format: "txt",
      byteLength: bytes.length,
      fileDigest,
    }),
    uploadId = begun.state.initial.uploadId,
    request: ProjectSourcePreparationRequest = {
      actor: { ...uploadActor, actorId: "agent-device" },
      uploadId,
      fileDigest,
      projectId: null,
    };
  assert.ok(Object.isFrozen(bridge));
  await assert.rejects(
    bridge.loadPrepared(request),
    /project_source_upload_not_ready/u,
  );
  const written = await service.writePart(uploadActor, {
    uploadId,
    expectedRevision: begun.state.revision,
    index: 0,
    byteOffset: 0,
    rawDigest: fileDigest,
    bytes,
  });
  await service.prepare(uploadActor, {
    uploadId,
    expectedRevision: written.state.revision,
  });
  permissions.length = 0;
  const createdSource = await bridge.loadPrepared(request),
    appendedSource = await bridge.loadPrepared({
      ...request,
      projectId: "existing-project",
    });
  assert.deepEqual(createdSource, appendedSource);
  assert.equal(createdSource.provenance.uploadId, uploadId);
  assert.equal(createdSource.fileDigest, fileDigest);
  assert.equal(createdSource.digest, uploadSha("原文😀\n故事"));
  assert.deepEqual(
    [
      ...new Set(
        permissions.map((permission) => permission.resource.projectId),
      ),
    ],
    [null, "existing-project"],
  );
  assert.ok(
    permissions.every(
      (permission) =>
        permission.action === "projectSourceUpload:adopt" &&
        permission.actor.actorId === "agent-device",
    ),
  );
  permissions.length = 0;
  const authority = bridge.captureAdoptionAuthority({
    ...request,
    projectId: "existing-project",
  });
  assert.equal(
    permissions.length,
    0,
    "capture itself makes no authorization decision",
  );
  assert.equal(authority.permission.action, "projectSourceUpload:adopt");
  assert.equal(authority.permission.resource.projectId, "existing-project");
  await authority.assertCurrent();
  assert.equal(permissions.length, 1);
  assert.equal(f.flags.parses, 1);
  f.flags.denyAction = "projectSourceUpload:adopt";
  await assert.rejects(
    authority.assertCurrent(),
    (error: unknown) =>
      error instanceof ApplicationError && error.category === "authorization",
  );
  await assert.rejects(
    bridge.loadPrepared(request),
    (error: unknown) =>
      error instanceof ApplicationError && error.category === "authorization",
  );
  f.flags.denyAction = null;
  await assert.rejects(
    bridge.loadPrepared({
      ...request,
      actor: { ...request.actor, principalId: "different-owner" },
    }),
    /project_source_upload_not_found/u,
  );
});

test("bridge rejects missing/extra/accessor-backed targets before invoking its captured upload service", async () => {
  let called = 0,
    getters = 0;
  const actual = new ProjectSourceUploadApplicationService(
      sourceUploadFixture().dependencies,
    ),
    host = {
      captureAdoptionAuthority: actual.captureAdoptionAuthority.bind(actual),
      async getPreparedForAdoption(): ReturnType<
        ProjectSourceUploadApplicationService["getPreparedForAdoption"]
      > {
        called++;
        throw new Error("captured-host");
      },
    },
    bridge = new ProjectSourceUploadFoundationAdapter(host),
    request = {
      actor: uploadActor,
      uploadId: "upload",
      fileDigest: uploadSha("raw"),
      projectId: null,
    };
  host.getPreparedForAdoption = async () => {
    throw new Error("replacement-host");
  };
  const accessor = { ...request };
  Object.defineProperty(accessor, "projectId", {
    enumerable: true,
    get() {
      getters++;
      return "caller-project";
    },
  });
  const { projectId: _projectId, ...missingTarget } = request;
  for (const bad of [
    missingTarget,
    { ...request, projectId: undefined },
    { ...request, projectId: "" },
    { ...request, owner: "caller-owner" },
    { ...request, provenance: {} },
    accessor,
  ]) {
    await assert.rejects(
      bridge.loadPrepared(bad as unknown as ProjectSourcePreparationRequest),
    );
    assert.throws(() =>
      bridge.captureAdoptionAuthority(
        bad as unknown as ProjectSourcePreparationRequest,
      ),
    );
  }
  assert.equal(called, 0);
  assert.equal(getters, 0);
  await assert.rejects(bridge.loadPrepared(request), /captured-host/u);
  assert.equal(called, 1);
});
