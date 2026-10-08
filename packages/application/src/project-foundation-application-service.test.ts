import assert from "node:assert/strict";
import test from "node:test";
import {
  appendProjectBriefRevision,
  createCreativeProject,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ProjectSourceUploadPreparedPointer } from "./project-source-upload-port.ts";
import {
  actor,
  createCommand,
  createFixture,
  preparedSource,
  replaceProject,
  sha256,
  sourceKey,
} from "./project-foundation-application-test-support.ts";

const category = (category: ApplicationError["category"]) => (error: unknown) =>
  error instanceof ApplicationError && error.category === category;
async function savedPlan(
  f: ReturnType<typeof createFixture>,
  origin: "creative" | "novel" = "creative",
) {
  const created = await f.service.createProject(actor, createCommand(origin));
  const command = {
    projectId: created.project.projectId,
    expectedFoundationRevision: 1,
    expectedProposalRevision: 0,
    kind:
      origin === "creative"
        ? ("creative-plan" as const)
        : ("novel-adaptation" as const),
    text: "先相遇，再误会，最终作出选择。",
    idempotencyKey: "save-plan",
  };
  const saved = await f.service.saveProposal(actor, command);
  const confirm = {
    projectId: created.project.projectId,
    expectedFoundationRevision: 1,
    proposalRevision: saved.proposal!.revision,
    proposalDigest: saved.proposal!.contentDigest,
    idempotencyKey: "confirm-plan",
  };
  return { created, saved, command, confirm };
}

test("creative foundation executes all metadata stages while keeping the original project shape", async () => {
  const f = createFixture();
  const { created, saved, confirm } = await savedPlan(f);
  assert.equal(Object.hasOwn(created.project, "origin"), false);
  assert.equal(created.project.revision, 2);
  assert.equal(saved.foundation.revision, 1);
  const confirmed = await f.service.confirmProposal(actor, confirm);
  assert.equal(confirmed.foundation.revision, 2);
  assert.deepEqual(confirmed.foundation.confirmedProposal, {
    revision: saved.proposal!.revision,
    digest: saved.proposal!.contentDigest,
  });
  const updated = await f.service.updateParameters(actor, {
    projectId: created.project.projectId,
    expectedFoundationRevision: 2,
    parameters: { ...created.foundation.parameters, episodeCount: 4 },
    idempotencyKey: "parameters",
  });
  assert.equal(updated.foundation.revision, 3);
  assert.equal(updated.foundation.parametersRevision, 2);
  assert.equal(updated.foundation.confirmedProposal, null);
  const direct = await f.service.chooseCreativeStartMode(actor, {
    projectId: created.project.projectId,
    expectedFoundationRevision: 3,
    creativeStartMode: "direct-script",
    idempotencyKey: "direct",
  });
  assert.equal(direct.foundation.revision, 4);
  assert.equal(direct.foundation.creativeStartMode, "direct-script");
  assert.deepEqual(
    await f.service.getFoundation(actor, {
      projectId: created.project.projectId,
    }),
    direct.foundation,
  );
  assert.ok(f.authorizations.includes("creativeProject:create"));
  assert.ok(f.authorizations.includes("creativeProject:write"));
  assert.ok(f.authorizations.includes("creativeProject:read"));
});

test("novel source preparation is owner-bound and scope/audit are supplied by the actual invocation", async () => {
  const f = createFixture();
  const otherDevice = { ...actor, actorId: "agent-device" };
  const created = await f.service.createProject(
    otherDevice,
    createCommand("novel"),
  );
  assert.equal(created.source!.createdByActorId, otherDevice.actorId);
  assert.equal(created.source!.projectId, created.project.projectId);
  assert.equal(created.source!.tenantId, actor.tenantId);
  assert.equal(created.source!.createdAt, created.foundation.createdAt);
  const source = await f.service.getSource(otherDevice, {
    projectId: created.project.projectId,
    sourceRevision: 1,
  });
  assert.deepEqual(source, created.source);
  const appended = await f.service.appendSource(otherDevice, {
    projectId: created.project.projectId,
    expectedFoundationRevision: 1,
    sourceUpload: {
      uploadId: "upload-2",
      fileDigest: preparedSource("upload-2").fileDigest,
    },
    idempotencyKey: "append-source",
  });
  assert.equal(appended.source!.revision, 2);
  assert.equal(appended.source!.createdByActorId, otherDevice.actorId);
  assert.equal(appended.foundation.revision, 2);
  assert.deepEqual(
    await f.service.getSource(otherDevice, {
      projectId: created.project.projectId,
      sourceRevision: 1,
    }),
    created.source,
  );
  assert.deepEqual(
    f.sourceRequests.map((request) => request.projectId),
    [null, created.project.projectId],
  );
});

test("default durable admission refuses legacy source recipes before allocating a project identity or persisting anything", async () => {
  for (const origin of ["creative", "novel"] as const) {
    const f = createFixture({}),
      command = createCommand(origin);
    await assert.rejects(
      f.service.createProject(actor, {
        ...command,
        sourceUpload: {
          uploadId: "upload-1",
          fileDigest: preparedSource().fileDigest,
        },
      }),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === "project_foundation_source_provenance_required",
    );
    assert.equal(f.idCalls, 0);
    assert.equal(f.clockCalls, 0);
    assert.equal(f.store.projects.size, 0);
    assert.equal(f.store.sources.size, 0);
    assert.equal(f.store.receipts.size, 0);
  }
  const f = createFixture({});
  assert.equal(
    (await f.service.createProject(actor, createCommand())).source,
    null,
  );
});

test("default admission forwards captured host locators for create and append while source proof stays out of public results", async () => {
  // This memory Store checks Application plumbing only. Real SQL must independently qualify
  // the persisted immutable upload ledger and associate it in its project transaction.
  const f = createFixture({}),
    pointer: ProjectSourceUploadPreparedPointer = {
      version: "crewon.project-source-upload-prepared.v1",
      storageRealmId: "fixture-db",
      uploadId: "upload-1",
      uploadDigest: sha256("raw-ledger"),
      preparedDigest: sha256("prepared-ledger"),
      normalizationParserVersion: "fixture-parser-v1",
    };
  f.uploads.set("upload-1", { ...preparedSource(), provenance: pointer });
  const created = await f.service.createProject(actor, createCommand("novel")),
    appended = await f.service.appendSource(actor, {
      projectId: created.project.projectId,
      expectedFoundationRevision: 1,
      sourceUpload: {
        uploadId: "upload-1",
        fileDigest: preparedSource().fileDigest,
      },
      idempotencyKey: "same-immutable-upload",
    });
  for (const revision of [1, 2]) {
    const stored = f.store.sourceUploads.get(
      sourceKey(created.project, revision),
    );
    assert.deepEqual(stored, pointer);
    assert.notEqual(stored, pointer);
    assert.ok(Object.isFrozen(stored));
  }
  assert.deepEqual(
    f.sourceRequests.map((request) => request.projectId),
    [null, created.project.projectId],
  );
  for (const result of [created, appended]) {
    assert.equal(Object.hasOwn(result, "sourceUpload"), false);
    assert.equal(Object.hasOwn(result.source!, "provenance"), false);
    assert.equal(Object.hasOwn(result.source!, "sourceUpload"), false);
  }
  f.uploads.clear();
  const ids = f.idCalls,
    sourceCalls = f.sourceCalls;
  assert.equal(
    (await f.service.createProject(actor, createCommand("novel"))).disposition,
    "replayed",
  );
  assert.equal(f.idCalls, ids);
  assert.equal(f.sourceCalls, sourceCalls);
});

test("default admission rejects appending an unproven source and public commands cannot carry internal locators", async () => {
  const f = createFixture({}),
    created = await f.service.createProject(actor, createCommand());
  await assert.rejects(
    f.service.appendSource(actor, {
      projectId: created.project.projectId,
      expectedFoundationRevision: 1,
      sourceUpload: {
        uploadId: "upload-1",
        fileDigest: preparedSource().fileDigest,
      },
      idempotencyKey: "unproven-append",
    }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "project_foundation_source_provenance_required",
  );
  assert.equal(f.store.sources.size, 0);
  assert.equal(f.store.sourceUploads.size, 0);
  assert.equal(f.store.receipts.size, 1);
  await assert.rejects(
    f.service.createProject(actor, {
      ...createCommand("novel"),
      sourceUpload: { ...createCommand("novel").sourceUpload!, provenance: {} },
    } as unknown as ReturnType<typeof createCommand>),
    category("validation"),
  );
});

test("committed create and append replays precede IDs, clocks and source preparation", async () => {
  const f = createFixture();
  const command = createCommand("novel");
  const first = await f.service.createProject(actor, command);
  const counts = {
    ids: f.idCalls,
    clocks: f.clockCalls,
    sources: f.sourceCalls,
  };
  f.uploads.clear();
  assert.deepEqual(await f.service.createProject(actor, command), {
    ...first,
    disposition: "replayed",
  });
  assert.deepEqual(
    { ids: f.idCalls, clocks: f.clockCalls, sources: f.sourceCalls },
    counts,
  );
  f.uploads.set("upload-2", preparedSource("upload-2"));
  const append = {
    projectId: first.project.projectId,
    expectedFoundationRevision: 1,
    sourceUpload: {
      uploadId: "upload-2",
      fileDigest: preparedSource("upload-2").fileDigest,
    },
    idempotencyKey: "append-once",
  };
  const result = await f.service.appendSource(actor, append);
  const after = {
    ids: f.idCalls,
    clocks: f.clockCalls,
    sources: f.sourceCalls,
  };
  f.uploads.clear();
  assert.deepEqual(await f.service.appendSource(actor, append), {
    ...result,
    disposition: "replayed",
  });
  assert.deepEqual(
    { ids: f.idCalls, clocks: f.clockCalls, sources: f.sourceCalls },
    after,
  );
  await assert.rejects(
    f.service.createProject(actor, { ...command, briefText: "新的想法" }),
    category("conflict"),
  );
});

test("historical confirmation replay remains valid after current parameters and source advance", async () => {
  const f = createFixture();
  const { created, confirm } = await savedPlan(f, "novel");
  const result = await f.service.confirmProposal(actor, confirm);
  const updated = await f.service.updateParameters(actor, {
    projectId: created.project.projectId,
    expectedFoundationRevision: 2,
    parameters: { ...created.foundation.parameters, episodeCount: 5 },
    idempotencyKey: "new-parameters",
  });
  await f.service.appendSource(actor, {
    projectId: created.project.projectId,
    expectedFoundationRevision: updated.foundation.revision,
    sourceUpload: {
      uploadId: "upload-2",
      fileDigest: preparedSource("upload-2").fileDigest,
    },
    idempotencyKey: "new-source",
  });
  assert.deepEqual(await f.service.confirmProposal(actor, confirm), {
    ...result,
    disposition: "replayed",
  });
});

test("no-op parameter and start-mode changes preserve an existing confirmation", async () => {
  const f = createFixture();
  const { created, confirm } = await savedPlan(f);
  const result = await f.service.confirmProposal(actor, confirm);
  const unchanged = await f.service.updateParameters(actor, {
    projectId: created.project.projectId,
    expectedFoundationRevision: 2,
    parameters: created.foundation.parameters,
    idempotencyKey: "same-parameters",
  });
  assert.deepEqual(unchanged.foundation, result.foundation);
  const mode = await f.service.chooseCreativeStartMode(actor, {
    projectId: created.project.projectId,
    expectedFoundationRevision: 2,
    creativeStartMode: "confirm-plan",
    idempotencyKey: "same-mode",
  });
  assert.deepEqual(mode.foundation, result.foundation);
});

test("PDP denial precedes identity creation, source preparation and persistence", async () => {
  const f = createFixture();
  f.allow = false;
  await assert.rejects(
    f.service.createProject(actor, createCommand("novel")),
    category("authorization"),
  );
  assert.equal(f.idCalls, 0);
  assert.equal(f.sourceCalls, 0);
  assert.equal(f.store.calls.length, 0);
});

test("PDP withdrawal after source loading and on the Store commit fence prevents all writes", async () => {
  for (const where of ["preparation", "commit"] as const) {
    const f = createFixture();
    if (where === "preparation")
      f.sourceBefore = async () => {
        f.allow = false;
      };
    else
      f.store.before = async (method) => {
        if (method === "commitCreation") f.allow = false;
      };
    await assert.rejects(
      f.service.createProject(actor, createCommand("novel")),
      category("authorization"),
    );
    assert.equal(f.store.projects.size, 0);
    assert.equal(f.store.sources.size, 0);
    assert.equal(f.store.receipts.size, 0);
  }
});

test("late PDP and external authority withdrawal do not deny a confirmed successful commit", async () => {
  const f = createFixture();
  let active = true;
  const authority = {
    async assertCurrent() {
      assert.ok(active);
    },
    assertActive() {
      assert.ok(active);
    },
  };
  f.store.afterCommit = () => {
    f.allow = false;
    active = false;
  };
  const result = await f.service.createProject(actor, createCommand("novel"), {
    authority,
  });
  assert.equal(result.disposition, "committed");
  assert.equal(f.store.receipts.size, 1);
  await assert.rejects(
    f.service.createProject(actor, createCommand("novel"), { authority }),
    category("authorization"),
  );
});

test("source preparation rejects wrong owner, upload ID, file digest, normalized digest or chunk digest", async () => {
  const original = preparedSource();
  for (const replacement of [
    { ...original, owner: { ...original.owner, principalId: "other-owner" } },
    { ...original, uploadId: "other-upload" },
    { ...original, fileDigest: sha256("other-raw") },
    { ...original, digest: sha256("other-normalized") },
    {
      ...original,
      chunks: original.chunks.map((chunk, i) =>
        i === 0 ? { ...chunk, digest: sha256("corrupted") } : chunk,
      ),
    },
  ]) {
    const f = createFixture();
    f.uploads.set("upload-1", replacement);
    await assert.rejects(
      f.service.createProject(actor, createCommand("novel")),
    );
    assert.equal(f.idCalls, 0);
    assert.equal(f.store.projects.size, 0);
  }
});

test("asynchronous assertActive cannot be hidden by the composed application authority", async () => {
  const f = createFixture();
  const authority = { async assertCurrent() {}, async assertActive() {} };
  await assert.rejects(
    f.service.createProject(actor, createCommand(), { authority }),
    category("internal"),
  );
  assert.equal(f.idCalls, 0);
  assert.equal(f.store.receipts.size, 0);
});

test("external authority withdrawn during source preparation is checked before clock/ID allocation", async () => {
  const f = createFixture();
  let active = true;
  const authority = {
    async assertCurrent() {
      assert.ok(active);
    },
    assertActive() {
      assert.ok(active);
    },
  };
  f.sourceBefore = async () => {
    active = false;
  };
  await assert.rejects(
    f.service.createProject(actor, createCommand("novel"), { authority }),
    category("internal"),
  );
  assert.equal(f.idCalls, 0);
  assert.equal(f.clockCalls, 0);
  assert.equal(f.store.receipts.size, 0);
});

test("a proposal kind or adaptation parameter set for another origin is rejected as invalid input", async () => {
  const f = createFixture();
  const created = await f.service.createProject(actor, createCommand());
  await assert.rejects(
    f.service.saveProposal(actor, {
      projectId: created.project.projectId,
      expectedFoundationRevision: 1,
      expectedProposalRevision: 0,
      kind: "novel-adaptation",
      text: "错误的项目类型",
      idempotencyKey: "wrong-kind",
    }),
    category("validation"),
  );
  await assert.rejects(
    f.service.updateParameters(actor, {
      projectId: created.project.projectId,
      expectedFoundationRevision: 1,
      parameters: createCommand("novel").parameters,
      idempotencyKey: "wrong-adaptation",
    }),
    category("validation"),
  );
  assert.equal(f.store.proposals.size, 0);
  assert.equal(f.store.receipts.size, 1);
});

test("strict commands reject extra scope/raw source and nested parameter or array getters without executing them", async () => {
  const f = createFixture();
  let calls = 0;
  const command = createCommand("novel");
  const parameters = { ...command.parameters };
  Object.defineProperty(parameters, "genre", {
    enumerable: true,
    get() {
      calls++;
      return "悬疑";
    },
  });
  const retained = ["林雨"];
  Object.defineProperty(retained, "0", {
    enumerable: true,
    get() {
      calls++;
      return "林雨";
    },
  });
  for (const input of [
    { ...command, owner: actor },
    { ...command, source: originalSource() },
    { ...command, parameters },
    {
      ...command,
      parameters: {
        ...command.parameters,
        adaptation: {
          ...command.parameters.adaptation!,
          retainedCharacters: retained,
        },
      },
    },
  ])
    await assert.rejects(
      f.service.createProject(actor, input as never),
      category("validation"),
    );
  assert.equal(calls, 0);
  assert.equal(f.sourceCalls, 0);
  assert.equal(f.idCalls, 0);
});
function originalSource() {
  return { text: "不允许公开传正文" };
}

test("cross-owner access is refused and malicious Store scope results are never published", async () => {
  const f = createFixture();
  const result = await f.service.createProject(actor, createCommand());
  const other = { ...actor, principalId: "other-principal" };
  await assert.rejects(
    f.service.getFoundation(other, { projectId: result.project.projectId }),
    category("notFound"),
  );
  await assert.rejects(
    f.service.updateParameters(other, {
      projectId: result.project.projectId,
      expectedFoundationRevision: 1,
      parameters: result.foundation.parameters,
      idempotencyKey: "cross-owner",
    }),
    category("notFound"),
  );
  f.store.override = (method, raw) =>
    method === "loadFoundation"
      ? { ...(raw as object), tenantId: "other-tenant" }
      : raw;
  await assert.rejects(
    f.service.getFoundation(actor, { projectId: result.project.projectId }),
    category("internal"),
  );
});

test("CAS and original archive state are checked before another source is prepared", async () => {
  const f = createFixture();
  const result = await f.service.createProject(actor, createCommand("novel"));
  const append = {
    projectId: result.project.projectId,
    expectedFoundationRevision: 2,
    sourceUpload: {
      uploadId: "upload-2",
      fileDigest: preparedSource("upload-2").fileDigest,
    },
    idempotencyKey: "stale-source",
  };
  await assert.rejects(
    f.service.appendSource(actor, append),
    category("conflict"),
  );
  assert.equal(f.sourceCalls, 1);
  replaceProject(f, { ...result.project, state: "archived" });
  await assert.rejects(
    f.service.appendSource(actor, { ...append, expectedFoundationRevision: 1 }),
    category("conflict"),
  );
  assert.equal(f.sourceCalls, 1);
});

test("confirmation reads the exact persisted proposal and refuses wrong digest or stale binding", async () => {
  const f = createFixture();
  const { created, confirm } = await savedPlan(f);
  await assert.rejects(
    f.service.confirmProposal(actor, {
      ...confirm,
      proposalDigest: sha256("unsaved"),
    }),
    category("conflict"),
  );
  await f.service.updateParameters(actor, {
    projectId: created.project.projectId,
    expectedFoundationRevision: 1,
    parameters: { ...created.foundation.parameters, episodeCount: 6 },
    idempotencyKey: "changed-before-confirm",
  });
  await assert.rejects(
    f.service.confirmProposal(actor, {
      ...confirm,
      expectedFoundationRevision: 2,
    }),
    category("conflict"),
  );
  assert.equal(f.store.receipts.size, 3);
});

test("source pages and chapter cursors are bounded, scalar-based and require post-read authorization", async () => {
  const f = createFixture();
  const created = await f.service.createProject(actor, createCommand("novel"));
  const scope = {
    projectId: created.project.projectId,
    sourceRevision: 1,
    sourceDigest: created.source!.digest,
  };
  const page = await f.service.readSourcePage(actor, {
    ...scope,
    startOffset: 1,
    limit: 5,
  });
  assert.equal(page.content, "😀夜\n重逢");
  assert.equal(page.endOffset, 6);
  const first = await f.service.listSourceChapters(actor, {
    ...scope,
    afterStartOffset: null,
    limit: 1,
  });
  assert.equal(first.chapters.length, 1);
  assert.equal(first.nextStartOffset, 0);
  const last = await f.service.listSourceChapters(actor, {
    ...scope,
    afterStartOffset: 0,
    limit: 1,
  });
  assert.equal(last.chapters[0]!.startOffset, 4);
  assert.equal(last.nextStartOffset, null);
  for (const limit of [0, 1_025])
    await assert.rejects(
      f.service.readSourcePage(actor, { ...scope, startOffset: 0, limit }),
      category("validation"),
    );
  await assert.rejects(
    f.service.listSourceChapters(actor, {
      ...scope,
      afterStartOffset: null,
      limit: 51,
    }),
    category("validation"),
  );
  await assert.rejects(
    f.service.readSourcePage(actor, {
      ...scope,
      sourceDigest: sha256("other"),
      startOffset: 0,
      limit: 1,
    }),
    category("conflict"),
  );
  f.store.before = async (method) => {
    if (method === "readSourcePage") f.allow = false;
  };
  await assert.rejects(
    f.service.readSourcePage(actor, { ...scope, startOffset: 0, limit: 1 }),
    category("authorization"),
  );
});

test("proposal history remains bounded and rejects modified canonical body/digest and duplicate cursor rows", async () => {
  const f = createFixture();
  const { created, saved } = await savedPlan(f);
  const second = await f.service.saveProposal(actor, {
    projectId: created.project.projectId,
    expectedFoundationRevision: 1,
    expectedProposalRevision: 1,
    kind: "creative-plan",
    text: "另一个版本的结局。",
    idempotencyKey: "plan-2",
  });
  const query = {
    projectId: created.project.projectId,
    afterProposalRevision: 0,
    limit: 1,
  };
  assert.deepEqual(await f.service.listProposals(actor, query), {
    proposals: [saved.proposal],
    nextRevision: 1,
  });
  assert.deepEqual(
    await f.service.listProposals(actor, {
      ...query,
      afterProposalRevision: 1,
    }),
    { proposals: [second.proposal], nextRevision: null },
  );
  f.store.override = (method, raw) =>
    method === "loadProposal"
      ? { ...(raw as object), text: "被篡改的正文" }
      : raw;
  await assert.rejects(
    f.service.getProposal(actor, {
      projectId: created.project.projectId,
      proposalRevision: 1,
    }),
    category("internal"),
  );
  f.store.override = (method, raw) =>
    method === "listProposals"
      ? { proposals: [saved.proposal, saved.proposal], nextRevision: null }
      : raw;
  await assert.rejects(
    f.service.listProposals(actor, { ...query, limit: 2 }),
    category("internal"),
  );
});

test("legacy foundation reads return null without inventing project origin or writes", async () => {
  const f = createFixture();
  const initial = createCreativeProject({
    scope: {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      projectId: "legacy",
    },
    actor,
    title: "旧项目",
    at: "2026-10-08T00:00:00.000Z",
  });
  const { project } = appendProjectBriefRevision(
    {
      project: initial,
      actor,
      expectedProjectRevision: 1,
      text: "原来的需求",
      at: initial.createdAt,
    },
    { sha256 },
  );
  replaceProject(f, project);
  assert.equal(
    await f.service.getFoundation(actor, { projectId: "legacy" }),
    null,
  );
  assert.equal(f.store.foundations.size, 0);
  assert.equal(f.store.receipts.size, 0);
});

test("the current foundation must reference a real source manifest with the same digest", async () => {
  const f = createFixture();
  const created = await f.service.createProject(actor, createCommand("novel"));
  f.store.sources.set(sourceKey(created.project, 1), {
    ...created.source!,
    digest: sha256("replaced-source"),
  });
  await assert.rejects(
    f.service.saveProposal(actor, {
      projectId: created.project.projectId,
      expectedFoundationRevision: 1,
      expectedProposalRevision: 0,
      kind: "novel-adaptation",
      text: "计划",
      idempotencyKey: "source-mismatch",
    }),
    category("conflict"),
  );
  assert.equal(f.store.proposals.size, 0);
});

test("committed and replayed DTOs are checked against the actual command before publication", async () => {
  for (const method of ["commitCreation", "loadMutationReceipt"] as const) {
    const f = createFixture();
    if (method === "loadMutationReceipt")
      await f.service.createProject(actor, createCommand());
    f.store.override = (candidate, raw) =>
      candidate === method && raw !== null
        ? {
            ...(raw as object),
            project: {
              ...(raw as { project: object }).project,
              title: "不匹配的标题",
            },
          }
        : raw;
    await assert.rejects(
      f.service.createProject(actor, createCommand()),
      category("internal"),
    );
  }
});
