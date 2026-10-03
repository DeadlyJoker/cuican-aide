import assert from "node:assert/strict";
import test from "node:test";
import {
  appendProjectBriefRevision,
  validateConceptAsset,
  renameCreativeProject,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import {
  taskActor,
  taskDigester,
} from "./extension-plugin-task.test-support.ts";
import { projectConceptSelectionFixture } from "./project-concept-selection.test-support.ts";
import type { ProjectConceptSelectionCommandSource } from "./project-concept-selection-store-port.ts";
import type { ProjectGenerationExecutionAuthority } from "./project-generation-execution-authority.ts";
import { uiDeferred } from "./plugin-ui.test-support.ts";

const category = (value: string) => (error: unknown) =>
  error instanceof ApplicationError && error.category === value;

test("explicit raw index selects the second image without new generation, prices or source edits", async () => {
  const f = await projectConceptSelectionFixture();
  const before = structuredClone({
    project: f.saved.f.state.project,
    asset: f.saved.f.state.asset,
  });
  const commits = f.saved.f.base.state.commits.length,
    quotes = f.saved.f.base.state.quoteCalls;
  assert.deepEqual((await f.saved.read())!.task.operations, []);
  const result = await f.select();
  assert.equal(result.resultLink.image.filename, "second.webp");
  assert.equal(result.resultLink.image.resultIndex, 1);
  assert.equal(result.resultLink.sourceRunId, f.generated.binding.runId);
  assert.equal(result.pointer.selectionRevision, 1);
  assert.equal(f.saved.f.base.state.commits.length, commits);
  assert.equal(f.saved.f.base.state.quoteCalls, quotes);
  assert.deepEqual(
    { project: f.saved.f.state.project, asset: f.saved.f.state.asset },
    before,
  );
  assert.ok(f.state.exactOperationReads > 0);
  assert.ok(
    f.state.transactionProjectReads.every(
      ([before, after]) => before === after,
    ),
  );
  assert.equal((await f.read()).current?.requiresConfirmation, false);
});

test("empty current pointer is authorized and does not implicitly select or create a Run", async () => {
  const f = await projectConceptSelectionFixture();
  assert.deepEqual(await f.read(), { selectionRevision: 0, current: null });
  assert.equal(f.state.exactOperationReads, 0);
  assert.equal(f.state.commitOptions.length, 0);
  f.saved.f.state.deniedProject = true;
  await assert.rejects(f.read(), category("authorization"));
});

test("HTTP and installed UI use separate trusted origins and same-key namespaces", async () => {
  const f = await projectConceptSelectionFixture();
  const first = await f.select();
  const second = await f.select(
    { ...f.command, expectedSelectionRevision: 1 },
    f.uiSource,
  );
  assert.equal(first.pointer.selectionRevision, 1);
  assert.equal(second.pointer.selectionRevision, 2);
  assert.deepEqual(
    f.state.commitOptions.map((option) => option.source.kind),
    ["authenticated-project-command", "installed-plugin-ui"],
  );
  assert.equal(f.state.receipts.size, 2);
});

test("installed origin cannot silently fall back when qualification is missing, changed or another actor", async () => {
  const f = await projectConceptSelectionFixture();
  await assert.rejects(
    f.select(f.command, { kind: "installed-plugin-ui" } as typeof f.uiSource),
  );
  const bad = {
    ...f.uiSource,
    publication: {
      ...f.uiSource.publication,
      sourcePin: {
        ...f.uiSource.publication.sourcePin,
        actorId: "different-actor",
      },
    },
  };
  await assert.rejects(f.select(f.command, bad), category("authorization"));
  f.state.currentPin = false;
  await assert.rejects(f.select(f.command, f.uiSource));
  assert.equal(f.state.receipts.size, 0);
  assert.equal(f.state.current, null);
});

test("caller URLs, source Runs, target, price and getters are rejected before Store IO", async () => {
  const f = await projectConceptSelectionFixture();
  for (const name of ["url", "sourceRunId", "target", "payer", "price"]) {
    await assert.rejects(
      f.select({ ...f.command, [name]: "caller-authority" }),
      category("validation"),
    );
  }
  let reads = 0;
  const malicious = { ...f.command };
  Object.defineProperty(malicious, "resultIndex", {
    enumerable: true,
    get() {
      reads++;
      return 0;
    },
  });
  await assert.rejects(f.select(malicious), category("validation"));
  assert.equal(reads, 0);
  assert.equal(f.state.receiptReads, 0);
  assert.equal(f.state.commitOptions.length, 0);
});

test("fresh selection enforces project and asset metadata CAS plus active project", async () => {
  for (const field of [
    "expectedProjectRevision",
    "expectedAssetMetadataRevision",
  ] as const) {
    const f = await projectConceptSelectionFixture();
    await assert.rejects(
      f.select({
        ...f.command,
        reference: { ...f.command.reference, [field]: 999 },
      }),
      category("conflict"),
    );
    assert.equal(f.state.commitOptions.length, 0);
  }
  const f = await projectConceptSelectionFixture();
  f.saved.f.archive();
  await assert.rejects(
    f.select({ ...f.command, reference: f.currentReference() }),
    category("conflict"),
  );
  assert.equal(f.state.commitOptions.length, 0);
});

test("historical input is explicitly selectable with current CAS and remains marked for confirmation", async () => {
  const f = await projectConceptSelectionFixture();
  f.saved.f.appendInput();
  const result = await f.select({
    ...f.command,
    reference: f.currentReference(),
  });
  assert.equal(result.pointer.reference.assetRevision, 1);
  assert.equal((await f.read()).current?.requiresConfirmation, true);
  f.saved.f.appendInput("另一个输入");
  const current = await f.read();
  assert.equal(
    current.current?.pointer.resultLinkDigest,
    result.resultLink.contentDigest,
  );
  assert.equal(current.current?.requiresConfirmation, true);
});

test("renaming project and asset preserves confirmation; newer brief changes it", async () => {
  const f = await projectConceptSelectionFixture();
  await f.select();
  f.saved.f.state.project = renameCreativeProject({
    project: f.saved.f.state.project,
    actor: taskActor,
    expectedProjectRevision: f.saved.f.state.project.revision,
    title: "改名",
    at: f.generated.run.state.createdAt,
  });
  f.saved.f.state.asset = validateConceptAsset({
    ...f.saved.f.state.asset,
    name: "资产改名",
    revision: f.saved.f.state.asset.revision + 1,
  });
  assert.equal((await f.read()).current?.requiresConfirmation, false);
  const next = appendProjectBriefRevision(
    {
      project: f.saved.f.state.project,
      actor: taskActor,
      expectedProjectRevision: f.saved.f.state.project.revision,
      text: "新的需求",
      at: f.generated.run.state.createdAt,
    },
    taskDigester,
  );
  f.saved.f.state.project = next.project;
  f.saved.f.state.briefs.set(next.brief.briefRevision, next.brief);
  assert.equal((await f.read()).current?.requiresConfirmation, true);
});

test("exact succeeded operation identity and revision are required independently of trimmed public task operations", async () => {
  for (const patch of [
    { tenantId: "different-tenant" },
    { runId: "different-run" },
    { bindingDigest: taskDigester.sha256("different-binding") },
    { operationId: "22222222-2222-4222-8222-222222222222" },
    { status: "running" },
    { revision: 4 },
    { resultJson: "x".repeat(16_385) },
  ]) {
    const f = await projectConceptSelectionFixture();
    f.state.operation = {
      ...f.state.operation!,
      ...patch,
    } as typeof f.state.operation;
    await assert.rejects(f.select());
    assert.equal(f.state.commitOptions.length, 0);
  }
  const f = await projectConceptSelectionFixture();
  await assert.rejects(f.select({ ...f.command, resultIndex: 2 }));
  assert.equal(f.state.commitOptions.length, 0);
});

test("original paid admission, current extension and original Run authorization cannot be skipped", async () => {
  const missing = await projectConceptSelectionFixture();
  missing.saved.f.base.state.admissions.clear();
  await assert.rejects(missing.select(), category("internal"));
  assert.equal(missing.state.commitOptions.length, 0);
  for (const action of ["extension:query", "run:read"] as const) {
    const f = await projectConceptSelectionFixture();
    f.saved.f.base.state.denied = action;
    await assert.rejects(f.select(), category("authorization"));
    assert.equal(f.state.commitOptions.length, 0);
  }
  const revoked = await projectConceptSelectionFixture();
  revoked.saved.state.activationState = "revoked";
  await assert.rejects(revoked.select());
  assert.equal(revoked.state.commitOptions.length, 0);
});

test("late transaction policy and synchronous activity withdrawal prevent publication", async () => {
  for (const withdraw of [
    (f: Awaited<ReturnType<typeof projectConceptSelectionFixture>>) => {
      f.state.alive = false;
    },
    (f: Awaited<ReturnType<typeof projectConceptSelectionFixture>>) => {
      f.saved.f.state.deniedProject = true;
    },
    (f: Awaited<ReturnType<typeof projectConceptSelectionFixture>>) => {
      f.saved.f.base.state.denied = "run:read";
    },
  ]) {
    const f = await projectConceptSelectionFixture();
    f.state.beforeCommit = () => withdraw(f);
    await assert.rejects(f.select(), category("authorization"));
    assert.equal(f.state.current, null);
    assert.equal(f.state.receipts.size, 0);
  }
});

test("a confirmed receipt remains sticky after owner closure and policy changes", async () => {
  const f = await projectConceptSelectionFixture();
  f.state.afterCommit = () => {
    f.state.alive = false;
    f.saved.f.state.deniedProject = true;
    f.saved.f.base.state.denied = "run:read";
    f.saved.f.archive();
  };
  const result = await f.select();
  assert.equal(result.disposition, "committed");
  assert.equal(result.resultLink.image.filename, "second.webp");
  assert.equal(f.state.receipts.size, 1);
});

test("old-key replay still enters Store transaction and cannot overwrite a newer pointer or require current source CAS", async () => {
  const f = await projectConceptSelectionFixture();
  const first = await f.select();
  const second = await f.select({
    ...f.command,
    resultIndex: 0,
    expectedSelectionRevision: 1,
    idempotencyKey: "new-selection",
  });
  f.saved.f.appendInput();
  f.saved.f.archive();
  const replay = await f.select();
  assert.equal(replay.disposition, "replayed");
  assert.deepEqual(replay.pointer, first.pointer);
  assert.equal(
    f.state.current?.pointer.contentDigest,
    second.pointer.contentDigest,
  );
  assert.equal(f.state.commitOptions.length, 3);
  assert.ok(
    f.state.transactionProjectReads.every(
      ([before, after]) => before === after,
    ),
  );
  await assert.rejects(
    f.select({ ...f.command, resultIndex: 0 }),
    category("conflict"),
  );
});

test("replay continues enforcing actual current UI pin and original immutable facts", async () => {
  const f = await projectConceptSelectionFixture();
  await f.select(f.command, f.uiSource);
  f.state.currentPin = false;
  await assert.rejects(f.select(f.command, f.uiSource));
  assert.equal(f.state.commitOptions.length, 2);
  assert.equal(f.state.current?.pointer.selectionRevision, 1);
  f.state.currentPin = true;
  f.state.operation = {
    ...f.state.operation!,
    resultJson: '{"pictures":["new-first.webp","new-second.webp"]}',
  };
  await assert.rejects(f.select(f.command, f.uiSource), category("internal"));
  assert.equal(f.state.current?.pointer.selectionRevision, 1);
});

test("captured readonly capability permits reading, cannot select, and later migration cannot widen the instance", async () => {
  const f = await projectConceptSelectionFixture();
  f.state.writeEnabled = false;
  const readonly = f.create();
  const versionReads = { ...f.state.versionReads };
  assert.deepEqual(await readonly.getConceptSelection(taskActor, f.query), {
    selectionRevision: 0,
    current: null,
  });
  await assert.rejects(
    readonly.selectConceptImage(taskActor, f.command, {
      authority: f.authority,
      source: f.source,
    }),
    category("conflict"),
  );
  f.state.writeEnabled = true;
  await assert.rejects(
    readonly.selectConceptImage(taskActor, f.command, {
      authority: f.authority,
      source: f.source,
    }),
    category("conflict"),
  );
  assert.deepEqual(f.state.versionReads, versionReads);
  assert.equal(f.state.receiptReads, 0);
  assert.equal(f.state.commitOptions.length, 0);
  await f
    .create()
    .selectConceptImage(taskActor, f.command, {
      authority: f.authority,
      source: f.source,
    });
  f.state.readEnabled = false;
  assert.throws(() => f.create(), category("internal"));
});

test("command is detached before awaited policy or receipt read and port accessors remain unread", async () => {
  const f = await projectConceptSelectionFixture();
  const wait = uiDeferred(),
    entered = uiDeferred();
  f.state.beforeReceipt = () => {
    entered.resolve();
    return wait.promise;
  };
  const mutable = structuredClone(f.command);
  const pending = f.select(mutable);
  await entered.promise;
  mutable.resultIndex = 0;
  mutable.reference = {
    ...mutable.reference,
    assetId: "caller-replaced-after-await",
  };
  wait.resolve();
  assert.equal((await pending).resultLink.image.resultIndex, 1);
  let evaluated = 0;
  const operations = Object.defineProperty({}, "loadExternalOperation", {
    get() {
      evaluated++;
      return async () => null;
    },
  });
  assert.throws(
    () =>
      f.create({ operations: operations as typeof f.dependencies.operations }),
    category("internal"),
  );
  assert.equal(evaluated, 0);
});

test("synchronous active fences reject Promise and thenable authority without getter execution", async () => {
  const f = await projectConceptSelectionFixture();
  let getterReads = 0;
  for (const value of [
    Promise.resolve(),
    Object.defineProperty({}, "then", {
      get() {
        getterReads++;
        throw new Error("unread");
      },
    }),
  ]) {
    const authority = {
      ...f.authority,
      assertActive: () => value,
    } as unknown as ProjectGenerationExecutionAuthority;
    await assert.rejects(
      f.service.selectConceptImage(taskActor, f.command, {
        authority,
        source: f.source,
      }),
    );
  }
  assert.equal(getterReads, 0);
  assert.equal(f.state.receiptReads, 0);
});

test("invalid source envelopes cannot claim authenticated composition while carrying UI qualification", async () => {
  const f = await projectConceptSelectionFixture();
  const source = {
    ...f.source,
    publication: f.uiSource.publication,
  } as ProjectConceptSelectionCommandSource;
  await assert.rejects(
    f.service.selectConceptImage(taskActor, f.command, {
      authority: f.authority,
      source,
    }),
  );
  assert.equal(f.state.receiptReads, 0);
});
