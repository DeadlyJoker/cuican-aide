import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ApplicationError,
  ProjectFoundationApplicationService,
} from "@crewon/application";
import { foundationToolsOwnerFixture } from "./project-foundation-tools-service-owner.test-support.ts";
import { readProjectFoundationRuntimeScope } from "./project-foundation-runtime-scope.ts";
import { deferred, tick } from "../plugin-tool-runtime-adapter.test-support.ts";

test("independent actual sidecar/marker and original discussion qualify scope; setup or copied command grants nothing", async (t) => {
  const f = await foundationToolsOwnerFixture(t),
    owner = f.owner(),
    service = f.service(owner),
    op = await f.prepare("readScope", {}),
    read = {
      foundations: f.foundationRuns,
      admission: f.taskAdmission,
      binding: f.binding,
      stageAdmission: f.stage,
      signal: new AbortController().signal,
    };
  assert.deepEqual(await readProjectFoundationRuntimeScope(read), f.admission);
  assert.equal(
    await readProjectFoundationRuntimeScope({
      ...read,
      foundations: {
        readRequiredFoundationDigest: async () => null,
        loadFoundationRunAdmission: async () => null,
      },
    }),
    null,
  );
  await assert.rejects(
    readProjectFoundationRuntimeScope({
      ...read,
      foundations: {
        readRequiredFoundationDigest: async () => null,
        loadFoundationRunAdmission: async () => f.admission,
      },
    }),
    /scope_mismatch/,
  );
  await assert.rejects(
    readProjectFoundationRuntimeScope({
      ...read,
      foundations: {
        readRequiredFoundationDigest: async () => f.admission.contentDigest,
        loadFoundationRunAdmission: async () => null,
      },
    }),
    /scope_missing/,
  );
  await assert.rejects(
    service.readScope({ command: op.command, request: {} }),
    /authority_denied/,
  );
  await assert.rejects(
    f.invoke(
      owner,
      op,
      (command) => service.readScope({ command, request: {} }),
      { copied: true },
    ),
    /authority_denied/,
  );
  const value = await f.invoke(owner, op, (command) =>
    service.readScope({ command, request: {} }),
  );
  assert.equal(value.scope.projectId, f.admission.projectId);
  assert.equal(value.scope.contentDigest, f.admission.contentDigest);
  assert.equal(Object.hasOwn(value.scope, "actor"), false);
  assert.equal(Object.hasOwn(value.scope, "installation"), false);
  assert.ok(
    Buffer.byteLength(JSON.stringify({ resultJson: JSON.stringify(value) })) <=
      8192,
  );
  const expired = f.owner({
    now: () => new Date(Date.parse(op.claim.lease.expiresAt) + 1),
  });
  await assert.rejects(
    f.invoke(expired, op, (command) =>
      f.service(expired).readScope({ command, request: {} }),
    ),
    /authority_denied/,
  );
  assert.throws(
    () =>
      f.owner({
        foundations: Object.create(
          ProjectFoundationApplicationService.prototype,
        ),
      }),
    /authority_denied/,
  );
});

test("new exact operations deny foreign project, different request and old text dispatch before reading or saving", async (t) => {
  const f = await foundationToolsOwnerFixture(t),
    owner = f.owner(),
    service = f.service(owner),
    request = { projectId: f.admission.projectId },
    op = await f.prepare("getFoundation", request);
  const value = await f.invoke(owner, op, (command) =>
    service.getFoundation({ command, request }),
  );
  assert.equal(value.foundation.origin, "creative");
  assert.equal(value.foundation.parameters.episodeMode, "series");
  await assert.rejects(
    f.invoke(owner, op, (command) =>
      service.getFoundation({ command, request: { projectId: "foreign" } }),
    ),
    /authority_denied/,
  );
  let proxyReads = 0;
  const proxy = new Proxy(request, {
    ownKeys() {
      proxyReads++;
      return ["projectId"];
    },
  });
  await assert.rejects(
    f.invoke(owner, op, (command) =>
      service.getFoundation({ command, request: proxy }),
    ),
    /authority_denied/,
  );
  assert.equal(proxyReads, 0);
  const foreign = await f.prepare("getFoundation", { projectId: "foreign" });
  let delegates = 0;
  await assert.rejects(
    f.invoke(owner, foreign, async () => {
      delegates++;
    }),
    /run_admission_invalid/,
  );
  const old = await f.prepareReadOperation("project_context_read", {});
  await assert.rejects(
    f.invoke(owner, old, async () => {
      delegates++;
    }),
    /authority_denied/,
  );
  assert.equal(delegates, 0);
  const absentRequest = {
      projectId: f.admission.projectId,
      proposalRevision: 99,
      proposalDigest: `sha256:${"a".repeat(64)}`,
      startOffset: 0,
      limit: 10,
    },
    absent = await f.prepare("getProposal", absentRequest);
  assert.deepEqual(
    await f.invoke(owner, absent, (command) =>
      service.getProposal({ command, request: absentRequest }),
    ),
    { proposal: null, page: null },
  );
  f.controls.service = false;
  await assert.rejects(
    f.invoke(owner, op, (command) =>
      service.getFoundation({ command, request }),
    ),
    /named_foundation_service_denied/,
  );
});

test("actual proposal Tool save commits once, remains unconfirmed and replays frozen metadata without whole-body echo", async (t) => {
  const f = await foundationToolsOwnerFixture(t),
    owner = f.owner(),
    service = f.service(owner),
    text = '雨😀夜\\\t\n"'.repeat(100),
    request = {
      projectId: f.admission.projectId,
      expectedFoundationRevision: 1,
      expectedProposalRevision: 0,
      kind: "creative-plan" as const,
      text,
    },
    op = await f.prepare("saveProposal", request),
    saved = await f.invoke(owner, op, (command) =>
      service.saveProposal({ command, request }),
    );
  assert.equal(saved.disposition, "committed");
  assert.equal(saved.proposal.revision, 1);
  assert.equal(saved.foundationRevision, 1);
  assert.equal(Object.hasOwn(saved.proposal, "text"), false);
  assert.ok(
    Buffer.byteLength(JSON.stringify({ resultJson: JSON.stringify(saved) })) <=
      8192,
  );
  const foundation = await f.foundations.getFoundation(f.actor, {
    projectId: request.projectId,
  });
  assert.equal(foundation?.confirmedProposal, null);
  assert.equal(foundation?.revision, 1);
  await owner.close();
  const cold = f.owner(),
    replay = await f.invoke(
      cold,
      op,
      (command) => f.service(cold).saveProposal({ command, request }),
      { method: "reconcile" },
    );
  assert.equal(replay.disposition, "replayed");
  assert.deepEqual(replay.proposal, saved.proposal);
  assert.equal(
    (await f.sql(`SELECT COUNT(*) AS n FROM ${f.prefix}project_proposals`))[0]
      ?.n,
    1,
  );
  const historyRequest = {
      projectId: request.projectId,
      afterProposalRevision: 0,
      limit: 4,
    },
    historyOp = await f.prepare("listProposals", historyRequest),
    history = await f.invoke(cold, historyOp, (command) =>
      f.service(cold).listProposals({ command, request: historyRequest }),
    );
  assert.equal(history.proposals.length, 1);
  assert.equal(Object.hasOwn(history.proposals[0]!, "text"), false);
  let restored = "",
    offset = 0;
  do {
    const read = {
        projectId: request.projectId,
        proposalRevision: 1,
        proposalDigest: saved.proposal.contentDigest,
        startOffset: offset,
        limit: 127,
      },
      readOp = await f.prepare("getProposal", read),
      response = await f.invoke(cold, readOp, (command) =>
        f.service(cold).getProposal({ command, request: read }),
      );
    assert.ok(response.proposal);
    assert.ok(response.page);
    assert.ok(Array.from(response.page.content).length <= 127);
    restored += response.page.content;
    if (response.page.nextOffset === null) break;
    offset = response.page.nextOffset;
  } while (true);
  assert.equal(restored, text);
  assert.equal(Object.hasOwn(service, "confirmProposal"), false);
  assert.ok(foundation);
  await f.foundations.updateParameters(f.actor, {
    projectId: request.projectId,
    expectedFoundationRevision: 1,
    parameters: { ...foundation.parameters, episodeCount: 4 },
    idempotencyKey: "manual-parameters-after-committed-proposal",
  });
  const changedReplay = await f.invoke(
    cold,
    op,
    (command) => f.service(cold).saveProposal({ command, request }),
    { method: "reconcile" },
  );
  assert.equal(changedReplay.disposition, "replayed");
  assert.deepEqual(changedReplay.proposal, saved.proposal);
  assert.equal(changedReplay.foundationRevision, 1);
  const fresh = { ...request, expectedProposalRevision: 1 },
    freshOp = await f.prepare("saveProposal", fresh);
  await assert.rejects(
    f.invoke(cold, freshOp, (command) =>
      f.service(cold).saveProposal({ command, request: fresh }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplicationError);
      assert.equal(error.category, "conflict");
      assert.equal(error.code, "project_foundation_run_inputs_stale");
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.message, "project_foundation_run_inputs_stale");
      return true;
    },
  );
});

test("actual novel source reads use admitted digest and scalar windows without full-source or owner/provenance leakage", async (t) => {
  const f = await foundationToolsOwnerFixture(t, "novel"),
    owner = f.owner(),
    service = f.service(owner),
    source = f.admission.source;
  assert.ok(source);
  const query = {
      projectId: f.admission.projectId,
      sourceRevision: source.revision,
      sourceDigest: source.digest,
    },
    sourceOp = await f.prepare("getSource", query),
    sourceResult = await f.invoke(owner, sourceOp, (command) =>
      service.getSource({ command, request: query }),
    );
  assert.equal(sourceResult.source.digest, source.digest);
  assert.equal(Object.hasOwn(sourceResult.source, "createdByActorId"), false);
  const chapterQuery = { ...query, limit: 16 },
    chapterOp = await f.prepare("listSourceChapters", chapterQuery),
    chapters = await f.invoke(owner, chapterOp, (command) =>
      service.listSourceChapters({ command, request: chapterQuery }),
    );
  assert.equal(chapters.chapters.length, 2);
  const firstQuery = { ...query, limit: 1 },
    firstOp = await f.prepare("listSourceChapters", firstQuery),
    first = await f.invoke(owner, firstOp, (command) =>
      service.listSourceChapters({ command, request: firstQuery }),
    );
  assert.equal(first.chapters[0]?.startOffset, 0);
  assert.equal(first.nextStartOffset, 0);
  const nextQuery = { ...query, afterStartOffset: 0, limit: 1 },
    nextOp = await f.prepare("listSourceChapters", nextQuery),
    next = await f.invoke(owner, nextOp, (command) =>
      service.listSourceChapters({ command, request: nextQuery }),
    );
  assert.equal(next.chapters.length, 1);
  assert.ok(next.chapters[0]!.startOffset > 0);
  const pageQuery = { ...query, startOffset: 1, limit: 1 },
    pageOp = await f.prepare("readSourcePage", pageQuery),
    page = await f.invoke(owner, pageOp, (command) =>
      service.readSourcePage({ command, request: pageQuery }),
    );
  assert.equal(page.page.content, "😀");
  assert.equal(page.page.endOffset, 2);
  assert.equal(page.page.characterLength, sourceResult.source.characterLength);
  const wrong = await f.prepare("getSource", {
    ...query,
    sourceDigest: `sha256:${"a".repeat(64)}`,
  });
  await assert.rejects(
    f.invoke(owner, wrong, async () => undefined),
    /run_admission_invalid/,
  );
});

test("parameter changes and original binding withdrawal revoke the captured scope", async (t) => {
  const f = await foundationToolsOwnerFixture(t),
    owner = f.owner(),
    service = f.service(owner),
    request = { projectId: f.admission.projectId },
    op = await f.prepare("getFoundation", request),
    binding = await f.conversations.store.loadBinding({
      actor: f.actor,
      profileId: f.taskAdmission.profileId,
      threadId: f.admission.threadId,
    });
  assert.ok(binding);
  await f.conversations.store.commitBinding(
    f.conversations.mutate(binding, "set-state"),
    { authority: f.conversations.authority },
  );
  await assert.rejects(
    f.invoke(owner, op, (command) =>
      service.getFoundation({ command, request }),
    ),
    /authority_denied/,
  );
  const g = await foundationToolsOwnerFixture(t),
    second = g.owner(),
    q = { projectId: g.admission.projectId },
    read = await g.prepare("getFoundation", q),
    initial = await g.foundations.getFoundation(g.actor, q);
  assert.ok(initial);
  await g.foundations.updateParameters(g.actor, {
    ...q,
    expectedFoundationRevision: 1,
    parameters: { ...initial.parameters, episodeCount: 4 },
    idempotencyKey: "manual-parameters-change",
  });
  await assert.rejects(
    g.invoke(second, read, (command) =>
      g.service(second).getFoundation({ command, request: q }),
    ),
    /run_inputs_stale/,
  );
});

test("pre-COMMIT withdrawal rolls back; post-COMMIT withdrawal still returns the exact committed proposal", async (t) => {
  const f = await foundationToolsOwnerFixture(t),
    owner = f.owner(),
    service = f.service(owner),
    request = {
      projectId: f.admission.projectId,
      expectedFoundationRevision: 1,
      expectedProposalRevision: 0,
      kind: "creative-plan" as const,
      text: "等待用户确认的方案",
    },
    op = await f.prepare("saveProposal", request);
  f.originalControls.beforeTransaction = () => {
    f.originalControls.live = false;
  };
  await assert.rejects(
    f.invoke(owner, op, (command) =>
      service.saveProposal({ command, request }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplicationError);
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.message, "named-current-owner-withdrawn");
      return true;
    },
  );
  assert.equal(
    (await f.sql(`SELECT COUNT(*) AS n FROM ${f.prefix}project_proposals`))[0]
      ?.n,
    0,
  );
  f.originalControls.live = true;
  f.originalControls.beforeTransaction = null;
  const prototype = DatabaseSync.prototype,
    prepare = Object.getOwnPropertyDescriptor(prototype, "prepare")!,
    exec = Object.getOwnPropertyDescriptor(prototype, "exec")!;
  let inserted = false,
    withdrew = false;
  Object.defineProperty(prototype, "prepare", {
    ...prepare,
    value: function (this: DatabaseSync, ...args: unknown[]) {
      const result = Reflect.apply(prepare.value, this, args);
      if (
        typeof args[0] === "string" &&
        /INSERT INTO .*project_proposals/u.test(args[0])
      ) {
        const statement = result as { run(...values: unknown[]): unknown },
          run = statement.run.bind(statement);
        statement.run = (...values) => {
          const result = run(...values);
          inserted = true;
          return result;
        };
      }
      return result;
    },
  });
  Object.defineProperty(prototype, "exec", {
    ...exec,
    value: function (this: DatabaseSync, ...args: unknown[]) {
      const result = Reflect.apply(exec.value, this, args);
      if (args[0] === "COMMIT" && inserted) {
        inserted = false;
        withdrew = true;
        f.originalControls.live = false;
        f.controls.service = false;
        f.state.policy = false;
      }
      return result;
    },
  });
  try {
    const saved = await f.invoke(owner, op, (command) =>
      service.saveProposal({ command, request }),
    );
    assert.equal(withdrew, true);
    assert.equal(saved.disposition, "committed");
    assert.equal(saved.proposal.revision, 1);
  } finally {
    Object.defineProperty(prototype, "prepare", prepare);
    Object.defineProperty(prototype, "exec", exec);
    f.originalControls.live = true;
  }
});

test("close withdraws authorization and joins physically pending scope calls and delegate before retirement", async (t) => {
  const f = await foundationToolsOwnerFixture(t),
    owner = f.owner(),
    service = f.service(owner),
    op = await f.prepare("readScope", {}),
    entered = deferred(),
    physical = deferred(),
    runtime = deferred();
  f.controls.beforeService = async () => {
    entered.resolve();
    await physical.promise;
  };
  const pending = f.invoke(owner, op, async (command) => {
    const call = assert.rejects(service.readScope({ command, request: {} }));
    await runtime.promise;
    await call;
  });
  await entered.promise;
  let joined = false;
  const closing = owner.close().then(() => {
    joined = true;
  });
  await tick();
  assert.equal(joined, false);
  physical.resolve();
  await tick();
  assert.equal(joined, false);
  runtime.resolve();
  await pending;
  await closing;
  assert.equal(joined, true);
  assert.equal(owner.canRetire(), true);
});
