import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "./application-error.ts";
import {
  actor,
  createCommand,
  createFixture,
  preparedSource,
  sha256,
} from "./project-foundation-application-test-support.ts";
import type { ProjectSourceUploadCommitAuthority } from "./project-source-upload-port.ts";
import {
  bindSourceAdoption,
  captureProjectSourceAdoptionAuthority,
} from "./project-source-adoption-authority.ts";
import {
  assertProjectFoundationCommitActive,
  assertProjectFoundationCommitCurrent,
  assertProjectFoundationCommitTransactionCurrent,
  captureProjectFoundationCommitAuthority,
  PROJECT_FOUNDATION_MUTATION_ACTIONS,
  qualifyProjectFoundationPluginCommit,
} from "./project-foundation-commit-authority.ts";
import { committedTaskContext } from "./plugin-ui-committed-task-support.ts";
import { committedUiFixture } from "./plugin-ui-committed-task.test-support.ts";

const denied = (error: unknown) =>
  error instanceof ApplicationError && error.category === "authorization";
function durableFixture(omitAdoptionAuthority?: true) {
  const f = createFixture({
    ...(omitAdoptionAuthority ? { omitAdoptionAuthority } : {}),
  });
  for (const uploadId of ["upload-1", "upload-2"])
    f.uploads.set(uploadId, {
      ...preparedSource(uploadId),
      provenance: {
        version: "crewon.project-source-upload-prepared.v1",
        storageRealmId: "fixture-db",
        uploadId,
        uploadDigest: sha256(`raw-${uploadId}`),
        preparedDigest: sha256(`prepared-${uploadId}`),
        normalizationParserVersion: "fixture-parser-v1",
      },
    });
  return f;
}
async function invocation(
  f: ReturnType<typeof durableFixture>,
  method: "create" | "append",
) {
  if (method === "create") {
    const command = createCommand("novel");
    return () => f.service.createProject(actor, command);
  }
  const created = await f.service.createProject(actor, createCommand("novel")),
    command = {
      projectId: created.project.projectId,
      expectedFoundationRevision: 1,
      sourceUpload: {
        uploadId: "upload-2",
        fileDigest: preparedSource("upload-2").fileDigest,
      },
      idempotencyKey: "append-durable",
    };
  return () => f.service.appendSource(actor, command);
}

test("a durable locator requires an explicit independent adoption callback before project ID allocation", async () => {
  const f = durableFixture(true);
  await assert.rejects(
    f.service.createProject(actor, createCommand("novel")),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "project_foundation_source_adoption_authority_required",
  );
  assert.equal(f.idCalls, 0);
  assert.equal(f.clockCalls, 0);
  assert.equal(f.store.projects.size, 0);
  const legacy = createFixture();
  await legacy.service.createProject(actor, createCommand("novel"));
  assert.equal(
    legacy.adoptionCaptures,
    0,
    "explicit legacy recipes confer no durable adoption claim",
  );
});

test("adoption callbacks for another actor, scope, upload, purpose or target are refused before allocation", async () => {
  const changes = [
    (a: ProjectSourceUploadCommitAuthority) => ({
      ...a,
      permission: {
        ...a.permission,
        actor: { ...a.permission.actor, actorId: "other-device" },
      },
    }),
    (a: ProjectSourceUploadCommitAuthority) => ({
      ...a,
      permission: {
        ...a.permission,
        resource: { ...a.permission.resource, uploadId: "other-upload" },
      },
    }),
    (a: ProjectSourceUploadCommitAuthority) => ({
      ...a,
      permission: {
        ...a.permission,
        resource: { ...a.permission.resource, projectId: "other-project" },
      },
    }),
    (a: ProjectSourceUploadCommitAuthority) => ({
      ...a,
      permission: { ...a.permission, action: "projectSourceUpload:status" },
    }),
    (a: ProjectSourceUploadCommitAuthority) => ({
      ...a,
      permission: {
        ...a.permission,
        resource: {
          ...a.permission.resource,
          owner: { ...a.permission.resource.owner, principalId: "other-owner" },
        },
      },
    }),
    (a: ProjectSourceUploadCommitAuthority) => ({
      ...a,
      assertActive: async () => {},
    }),
  ];
  for (const change of changes) {
    const f = durableFixture();
    f.adoptionOverride = change;
    await assert.rejects(
      f.service.createProject(actor, createCommand("novel")),
    );
    assert.equal(f.idCalls, 0);
    assert.equal(f.clockCalls, 0);
    assert.equal(f.store.projects.size, 0);
    assert.equal(f.store.receipts.size, 0);
  }
});

test("independent adoption denial and final synchronous withdrawal prevent create and append commits", async () => {
  for (const method of ["create", "append"] as const)
    for (const gate of ["current", "active"] as const) {
      const f = durableFixture(),
        run = await invocation(f, method),
        counts = {
          projects: f.store.projects.size,
          sources: f.store.sources.size,
          receipts: f.store.receipts.size,
        };
      f.store.before = async (name) => {
        if (
          name ===
          (method === "create" ? "commitCreation" : "commitFoundationChange")
        ) {
          if (gate === "current") f.allowAdoption = false;
          else f.activeAdoption = false;
        }
      };
      await assert.rejects(run(), denied);
      assert.equal(f.allow, true, "project permission remains allowed");
      assert.equal(f.store.projects.size, counts.projects);
      assert.equal(f.store.sources.size, counts.sources);
      assert.equal(f.store.receipts.size, counts.receipts);
    }
});

test("adoption withdrawal after a confirmed commit preserves the fact and replay does not re-import or adopt again", async () => {
  for (const method of ["create", "append"] as const) {
    const f = durableFixture(),
      run = await invocation(f, method);
    let counts: {
      captures: number;
      checks: number;
      activeChecks: number;
    } | null = null;
    f.store.afterCommit = () => {
      f.allowAdoption = false;
      f.activeAdoption = false;
      counts = {
        captures: f.adoptionCaptures,
        checks: f.adoptionChecks,
        activeChecks: f.adoptionActiveChecks,
      };
    };
    const result = await run();
    assert.equal(result.disposition, "committed");
    assert.deepEqual(
      {
        captures: f.adoptionCaptures,
        checks: f.adoptionChecks,
        activeChecks: f.adoptionActiveChecks,
      },
      counts,
    );
    const sourceCalls = f.sourceCalls,
      ids = f.idCalls;
    f.uploads.clear();
    f.sourceBefore = async () => {
      throw new Error("replay_must_not_prepare");
    };
    f.adoptionOverride = () => {
      throw new Error("replay_must_not_capture_adoption");
    };
    assert.deepEqual(await run(), { ...result, disposition: "replayed" });
    assert.equal(f.sourceCalls, sourceCalls);
    assert.equal(f.idCalls, ids);
    assert.deepEqual(
      {
        captures: f.adoptionCaptures,
        checks: f.adoptionChecks,
        activeChecks: f.adoptionActiveChecks,
      },
      counts,
    );
  }
});

test("source adoption composition preserves the independent installation transaction and checks both policy paths", async () => {
  const { pin, context } = committedTaskContext(
      committedUiFixture().detachedContext(),
    ),
    calls = {
      full: 0,
      transaction: 0,
      active: 0,
      adoption: 0,
      adoptionActive: 0,
    },
    state = { active: true },
    original = captureProjectFoundationCommitAuthority({
      authority: {
        async assertCurrent() {
          calls.full++;
        },
        assertActive() {
          calls.active++;
        },
        transaction: {
          version: "crewon.project-foundation-plugin-commit.v1",
          pin: {
            ...pin,
            action: PROJECT_FOUNDATION_MUTATION_ACTIONS["create-project"],
          },
          selection: context.selection,
          package: context.package,
          async assertCurrent() {
            calls.transaction++;
          },
        },
      },
    })!,
    request = {
      actor: context.actor,
      uploadId: "upload",
      fileDigest: sha256("raw"),
      projectId: null,
    },
    adoption = captureProjectSourceAdoptionAuthority(
      {
        version: "crewon.project-source-upload-commit.v1",
        permission: {
          actor: context.actor,
          action: "projectSourceUpload:adopt",
          resource: {
            kind: "projectSourceUpload",
            owner: {
              tenantId: context.actor.tenantId,
              spaceId: context.actor.spaceId,
              principalId: context.actor.principalId,
            },
            uploadId: "upload",
            projectId: null,
          },
        },
        async assertCurrent() {
          calls.adoption++;
          if (!state.active) throw new Error("independent_adoption_withdrawn");
        },
        assertActive() {
          calls.adoptionActive++;
          if (!state.active) throw new Error("independent_adoption_withdrawn");
        },
      },
      request,
    ),
    bound = bindSourceAdoption({ authority: original }, adoption).authority!;
  assert.deepEqual(bound.transaction!.pin, original.transaction!.pin);
  assert.deepEqual(
    bound.transaction!.selection,
    original.transaction!.selection,
  );
  assert.deepEqual(bound.transaction!.package, original.transaction!.package);
  assert.equal(bound.transaction!.version, original.transaction!.version);
  qualifyProjectFoundationPluginCommit(bound, context.actor, "create-project");
  await assertProjectFoundationCommitCurrent(bound);
  await assertProjectFoundationCommitTransactionCurrent(bound);
  assertProjectFoundationCommitActive(bound);
  assert.deepEqual(calls, {
    full: 1,
    transaction: 1,
    active: 1,
    adoption: 2,
    adoptionActive: 3,
  });
  state.active = false;
  await assert.rejects(
    assertProjectFoundationCommitTransactionCurrent(bound),
    /independent_adoption_withdrawn/u,
  );
  assert.throws(
    () => assertProjectFoundationCommitActive(bound),
    /independent_adoption_withdrawn/u,
  );
});
