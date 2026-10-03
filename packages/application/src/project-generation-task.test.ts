import assert from "node:assert/strict";
import test from "node:test";
import {
  createExtensionCreditAdmission,
  extensionCanonicalJson,
  type ProjectGenerationReference,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { CreativeProjectCommitAuthority } from "./creative-project-store-port.ts";
import { projectTaskFixture } from "./project-generation-task.test-support.ts";
import {
  taskActor,
  taskDigester,
  taskPin,
} from "./extension-plugin-task.test-support.ts";
import { withContentDigest } from "./creative-project.test-support.ts";

const error =
  (category: ApplicationError["category"], code?: string) => (value: unknown) =>
    value instanceof ApplicationError &&
    value.category === category &&
    (code === undefined || value.code === code);

test("project generation submits the exact saved input, reference and original paid pin in one existing Turn recipe", async () => {
  const f = projectTaskFixture();
  const result = await f.generate();
  assert.equal(result.run.disposition, "committed");
  assert.equal(f.base.state.commits.length, 1);
  assert.equal(f.base.state.quoteCalls, 1);
  const commit = f.base.state.commits[0]!;
  assert.deepEqual(commit.projectGeneration, f.reference);
  assert.equal(
    commit.turn.thread.messages[0]!.content,
    extensionCanonicalJson({ prompt: f.original.assetRevision.prompt }),
  );
  assert.deepEqual(commit.pluginAdmission, {
    schemaVersion: "crewon.plugin-task-admission.v1",
    ...taskPin,
    runId: result.binding.runId,
    threadId: f.command.threadId,
    extensionBindingDigest: result.binding.bindingDigest,
    requestDigest: commit.receipt.requestDigest,
    idempotencyKey: commit.receipt.idempotencyKey,
  });
  assert.equal(commit.creditAdmission?.reservation.quotedCredits, "3");
  assert.equal(
    commit.creditAdmission?.reservation.scope.principalId,
    taskActor.principalId,
  );
  assert.equal(result.binding.schemaVersion, "crewon.extension-run-binding.v0");
  assert.equal(result.binding.source, null);
  assert.deepEqual(Object.keys(commit.receipt).sort(), [
    "actorId",
    "idempotencyKey",
    "requestDigest",
  ]);
  const originalDigest = taskDigester.sha256(
    extensionCanonicalJson({
      schemaVersion: "crewon.plugin-task-command.v1",
      actor: taskActor,
      pin: taskPin,
      command: f.command,
    }),
  );
  assert.equal(
    commit.receipt.requestDigest,
    taskDigester.sha256(
      extensionCanonicalJson({
        schemaVersion: "crewon.project-generation-command.v0",
        taskRequestDigest: originalDigest,
        reference: f.reference,
      }),
    ),
  );
  const link = f.state.links.get(result.binding.runId)!;
  assert.deepEqual(link.reference, f.reference);
  assert.equal(link.assetContentDigest, f.original.assetRevision.contentDigest);
  assert.equal(link.briefContentDigest, f.original.brief.contentDigest);
  assert.equal(f.state.commitOptions.length, 1);
  assert.equal(
    typeof f.state.commitOptions[0]?.projectGenerationAuthority?.assertCurrent,
    "function",
  );
  assert.equal(JSON.stringify(commit).includes("assertCurrent"), false);
  assert.equal("projectGenerationAuthority" in commit, false);
});

test("project source owner and current write authorization are checked before a quote or Turn", async () => {
  for (const mode of [
    "owner",
    "project-deny",
    "extension-deny",
    "thread-deny",
    "run-deny",
  ] as const) {
    const f = projectTaskFixture();
    if (mode === "owner")
      f.state.project = {
        ...f.state.project,
        ownerPrincipalId: "foreign-principal",
      };
    if (mode === "project-deny") f.state.deniedProject = true;
    if (mode === "extension-deny") f.base.state.denied = "extension:run";
    if (mode === "thread-deny") f.base.state.denied = "thread:message:append";
    if (mode === "run-deny") f.base.state.denied = "run:create";
    await assert.rejects(
      f.generate(),
      mode === "owner"
        ? error("notFound", "creative_project_not_found")
        : error("authorization", "authorization_denied"),
    );
    assert.equal(f.base.state.quoteCalls, 0);
    assert.equal(f.base.state.commits.length, 0);
    assert.equal(f.state.links.size, 0);
  }
  const f = projectTaskFixture();
  f.state.project = { ...f.state.project, ownerPrincipalId: "foreign" };
  const poisoned = {
    ...f.store,
    async loadProject() {
      return f.state.project;
    },
  };
  await assert.rejects(
    f
      .create({ creativeProjects: { ...f.projects, store: poisoned } })
      .createProjectTaskFromPlugin(
        taskActor,
        f.command,
        taskPin,
        f.reference,
        f.authority,
      ),
    error("internal", "creative_project_store_result_invalid"),
  );
  assert.equal(f.base.state.commits.length, 0);
});

test("historical saved input remains usable with current metadata CAS while an unsaved or different prompt is rejected", async () => {
  const f = projectTaskFixture();
  f.appendInput("最新输入");
  const reference = {
    ...f.reference,
    expectedProjectRevision: f.state.project.revision,
    expectedAssetMetadataRevision: f.state.asset.revision,
  };
  await f
    .create()
    .createProjectTaskFromPlugin(
      taskActor,
      f.command,
      taskPin,
      reference,
      f.authority,
    );
  assert.equal(
    [...f.state.links.values()][0]!.assetContentDigest,
    f.original.assetRevision.contentDigest,
  );
  assert.equal(
    f.base.state.commits[0]!.binding.inputDigest,
    taskDigester.sha256(
      extensionCanonicalJson({ prompt: f.original.assetRevision.prompt }),
    ),
  );
  for (const prompt of ["未保存草稿", "最新输入"]) {
    const other = projectTaskFixture();
    other.appendInput("最新输入");
    await assert.rejects(
      other.create().createProjectTaskFromPlugin(
        taskActor,
        { ...other.command, intent: { kind: "generate", input: { prompt } } },
        taskPin,
        {
          ...other.reference,
          expectedProjectRevision: other.state.project.revision,
          expectedAssetMetadataRevision: other.state.asset.revision,
        },
        other.authority,
      ),
      error("validation", "creative_project_generation_input_mismatch"),
    );
    assert.equal(other.base.state.quoteCalls, 0);
    assert.equal(other.base.state.commits.length, 0);
  }
});

test("references, identities, commands and pin are detached before the first source-store await", async () => {
  const f = projectTaskFixture();
  const actor = { ...taskActor };
  const pin = { ...taskPin };
  const reference = { ...f.reference };
  const command = structuredClone(f.command);
  let changed = false;
  const store = {
    ...f.store,
    async loadProject(input: Parameters<typeof f.store.loadProject>[0]) {
      if (!changed) {
        changed = true;
        reference.assetId = "altered";
        reference.assetRevision = 999;
        actor.principalId = "foreign";
        pin.packageDigest = taskDigester.sha256("altered");
        command.intent.input.prompt = "altered";
      }
      return f.store.loadProject(input);
    },
  };
  await f
    .create({ creativeProjects: { ...f.projects, store } })
    .createProjectTaskFromPlugin(actor, command, pin, reference, f.authority);
  const commit = f.base.state.commits[0]!;
  assert.deepEqual(commit.projectGeneration, f.reference);
  assert.equal(commit.pluginAdmission?.packageDigest, taskPin.packageDigest);
  assert.equal(commit.pluginAdmission?.principalId, taskActor.principalId);
  assert.equal(
    commit.binding.inputDigest,
    taskDigester.sha256(
      extensionCanonicalJson({ prompt: f.original.assetRevision.prompt }),
    ),
  );
});

test("bounded reference traversal and trusted callback capture reject accessors without invoking them", async () => {
  let getters = 0;
  const cases: unknown[] = [
    { ...projectTaskFixture().reference, secret: "hidden" },
    { ...projectTaskFixture().reference, projectId: "x".repeat(70000) },
    Object.defineProperty(
      { ...projectTaskFixture().reference },
      "assetRevision",
      {
        enumerable: true,
        get() {
          getters++;
          return 1;
        },
      },
    ),
    { ...projectTaskFixture().reference, assetRevision: 1.5 },
  ];
  for (const reference of cases) {
    const f = projectTaskFixture();
    await assert.rejects(
      f
        .create()
        .createProjectTaskFromPlugin(
          taskActor,
          f.command,
          taskPin,
          reference as ProjectGenerationReference,
          f.authority,
        ),
      error("validation"),
    );
    assert.equal(f.state.projectReads.length, 0);
    assert.equal(f.base.state.quoteCalls, 0);
    assert.equal(f.base.state.commits.length, 0);
  }
  const f = projectTaskFixture();
  const authority = Object.defineProperty(
    { assertActive() {} },
    "assertCurrent",
    {
      enumerable: true,
      get() {
        getters++;
        return async () => {};
      },
    },
  );
  await assert.rejects(
    f
      .create()
      .createProjectTaskFromPlugin(
        taskActor,
        f.command,
        taskPin,
        f.reference,
        authority as CreativeProjectCommitAuthority,
      ),
    /creative_project_commit_authority_invalid/u,
  );
  assert.equal(getters, 0);
  assert.equal(f.state.projectReads.length, 0);
});

test("project adapter capability, link loader and host-issued commit authority are mandatory", async () => {
  for (const patch of [
    { creativeProjects: undefined },
    {
      extensions: {
        ...projectTaskFixture().extensions,
        projectGenerationVersion: undefined,
      },
    },
    {
      extensions: {
        ...projectTaskFixture().extensions,
        loadProjectGenerationLink: undefined,
      },
    },
  ]) {
    const f = projectTaskFixture();
    await assert.rejects(
      f
        .create(patch)
        .createProjectTaskFromPlugin(
          taskActor,
          f.command,
          taskPin,
          f.reference,
          f.authority,
        ),
      error("conflict", "creative_project_generation_unavailable"),
    );
    assert.equal(f.state.projectReads.length, 0);
    assert.equal(f.base.state.receiptReads, 0);
    assert.equal(f.base.state.quoteCalls, 0);
    assert.equal(f.base.state.commits.length, 0);
  }
  const f = projectTaskFixture();
  await assert.rejects(
    f
      .create()
      .createProjectTaskFromPlugin(
        taskActor,
        f.command,
        taskPin,
        f.reference,
        undefined as unknown as CreativeProjectCommitAuthority,
      ),
    error("conflict", "creative_project_generation_authority_unavailable"),
  );
  assert.equal(f.state.projectReads.length, 0);
});

test("same-key replay keeps the original Run, price and historical link after metadata advances and archive", async () => {
  const f = projectTaskFixture();
  const first = await f.generate();
  const counters = {
    ids: f.base.state.ids,
    clocks: f.base.state.clocks,
    configurations: f.base.state.configurationReads,
  };
  f.appendInput();
  f.archive();
  f.base.state.quote.quotedCredits = "999";
  f.state.projectReads.length = 0;
  const replay = await f
    .create({ creditQuotes: undefined })
    .createProjectTaskFromPlugin(
      taskActor,
      f.command,
      taskPin,
      f.reference,
      f.authority,
    );
  assert.equal(replay.run.disposition, "replayed");
  assert.equal(replay.binding.runId, first.binding.runId);
  assert.deepEqual(replay.creditAdmission, first.creditAdmission);
  assert.deepEqual(
    {
      ids: f.base.state.ids,
      clocks: f.base.state.clocks,
      configurations: f.base.state.configurationReads,
    },
    counters,
  );
  assert.equal(f.base.state.quoteCalls, 1);
  assert.equal(f.base.state.commits.length, 1);
  assert.equal(f.state.links.size, 1);
  assert.equal(
    f.state.projectReads.some(
      (read) =>
        read.method === "loadConceptRevision" || read.method === "loadBrief",
    ),
    false,
  );
});

test("adding, removing or changing a project reference with the same user key conflicts in the existing key namespace", async () => {
  const plain = projectTaskFixture();
  await plain.create().createTaskFromPlugin(taskActor, plain.command, taskPin);
  await assert.rejects(
    plain.generate(),
    error("conflict", "extension_idempotency_conflict"),
  );
  const f = projectTaskFixture();
  await f.generate();
  await assert.rejects(
    f.create().createTaskFromPlugin(taskActor, f.command, taskPin),
    error("conflict", "extension_idempotency_conflict"),
  );
  const patches: Partial<ProjectGenerationReference>[] = [
    { projectId: "another" },
    { assetId: "another" },
    { assetRevision: 2 },
    { expectedProjectRevision: 4 },
    { expectedAssetMetadataRevision: 2 },
  ];
  for (const patch of patches) {
    // A different project must exist for its current policy check, before the receipt is compared.
    const store = {
      ...f.store,
      async loadProject() {
        return {
          ...f.state.project,
          projectId: patch.projectId ?? f.reference.projectId,
        };
      },
    };
    await assert.rejects(
      f
        .create({ creativeProjects: { ...f.projects, store } })
        .createProjectTaskFromPlugin(
          taskActor,
          f.command,
          taskPin,
          { ...f.reference, ...patch },
          f.authority,
        ),
      error("conflict", "extension_idempotency_conflict"),
    );
  }
  assert.equal(f.base.state.commits.length, 1);
  assert.equal(f.base.state.quoteCalls, 1);
  assert.equal(
    plain.base.state.commits[0]!.receipt.idempotencyKey,
    f.base.state.commits[0]!.receipt.idempotencyKey,
  );
});

test("quote awaits cannot retain withdrawn project, execution, thread, run or host authority", async () => {
  for (const mode of [
    "project",
    "extension:run",
    "thread:message:append",
    "run:create",
    "host",
  ] as const) {
    const f = projectTaskFixture();
    f.base.state.onQuote = () => {
      if (mode === "project") f.state.deniedProject = true;
      else if (mode === "host") f.state.hostAlive = false;
      else f.base.state.denied = mode;
    };
    await assert.rejects(
      f.generate(),
      error(
        "authorization",
        mode === "host" ? "project_host_withdrawn" : "authorization_denied",
      ),
    );
    assert.equal(f.base.state.quoteCalls, 1);
    assert.equal(f.base.state.commits.length, 0);
    assert.equal(f.state.links.size, 0);
    assert.equal(f.base.state.receipts.size, 0);
  }
});

test("captured host callbacks preserve their receiver and cannot be replaced during the quote", async () => {
  const f = projectTaskFixture();
  f.base.state.onQuote = () => {
    Object.assign(f.authority, {
      assertCurrent() {
        throw new Error("replacement-invoked");
      },
      assertActive() {
        throw new Error("replacement-invoked");
      },
    });
  };
  const result = await f.generate();
  assert.equal(result.run.disposition, "committed");
  assert.ok(f.state.receiverChecks >= 4);
  assert.ok(f.state.activeChecks >= 2);
  assert.equal(f.base.state.commits.length, 1);
});

test("transaction policy callbacks do not acquire ordinary project-store reads", async () => {
  const f = projectTaskFixture();
  await f.generate();
  assert.equal(f.state.guardedProjectReadCounts.length, 1);
  const [before, after] = f.state.guardedProjectReadCounts[0]!;
  assert.ok(before > 0, "preflight must establish the actual source owner");
  assert.equal(
    after,
    before,
    "the borrowed transaction callback may not acquire a second shared-pool connection",
  );
});

test("source changes during the quote preserve exact CAS and archive conflict codes without publishing a receipt", async () => {
  for (const [mode, code] of [
    ["project", "creative_project_revision_conflict"],
    ["asset", "creative_project_asset_revision_conflict"],
    ["archive", "creative_project_archived"],
  ] as const) {
    const f = projectTaskFixture();
    f.base.state.onQuote = () => {
      if (mode === "project") f.appendInput();
      else if (mode === "asset")
        f.state.asset = {
          ...f.state.asset,
          revision: f.state.asset.revision + 1,
        };
      else f.archive();
    };
    await assert.rejects(f.generate(), error("conflict", code));
    assert.equal(f.base.state.quoteCalls, 1);
    assert.equal(f.base.state.commits.length, 0);
    assert.equal(f.base.state.receipts.size, 0);
    assert.equal(f.base.state.admissions.size, 0);
    assert.equal(f.state.links.size, 0);
  }
});

test("project commit mapping retains original insufficient-balance and task-receipt conflicts", async () => {
  for (const code of [
    "plugin_credit_insufficient_balance",
    "extension_idempotency_conflict",
  ]) {
    const f = projectTaskFixture();
    const cause = new Error(code);
    f.base.state.commitError = cause;
    await assert.rejects(
      f.generate(),
      (value) =>
        error("conflict", code)(value) &&
        (value as ApplicationError).cause === cause,
    );
    assert.equal(f.base.state.receipts.size, 0);
    assert.equal(f.base.state.admissions.size, 0);
    assert.equal(f.state.links.size, 0);
  }
});

test("withdrawal after confirmed COMMIT does not reject the receipt, but still verifies the complete saved link", async () => {
  const f = projectTaskFixture();
  f.state.afterConfirmedCommit = () => {
    f.state.hostAlive = false;
    f.state.deniedProject = true;
    f.base.state.denied = "run:create";
  };
  const result = await f.generate();
  assert.equal(result.run.disposition, "committed");
  assert.equal(f.state.links.size, 1);
  assert.equal(f.state.linkReads, 1);
  assert.deepEqual(
    f.state.links.get(result.binding.runId)!.receipt,
    f.base.state.commits[0]!.receipt,
  );
  assert.deepEqual(
    result.creditAdmission,
    f.base.state.commits[0]!.creditAdmission,
  );
});

test("ordinary v0 and paid-plugin tasks never read project metadata or require project capabilities", async () => {
  for (const paid of [false, true]) {
    const f = projectTaskFixture();
    const service = f.create({
      extensions: {
        ...f.extensions,
        projectGenerationVersion: undefined,
        loadProjectGenerationLink: undefined,
      },
    });
    if (paid) await service.createTaskFromPlugin(taskActor, f.command, taskPin);
    else await service.createTask(taskActor, f.command);
    assert.equal(f.state.projectReads.length, 0);
    assert.equal(f.state.projectPermissions.length, 0);
    assert.equal(f.state.linkReads, 0);
    assert.equal(f.state.links.size, 0);
    assert.equal(f.base.state.commits[0]!.projectGeneration, undefined);
    assert.equal(f.state.commitOptions[0], undefined);
  }
});

test("missing, corrupted or owner-tampered saved generation links fail closed on replay", async () => {
  for (const mode of [
    "missing",
    "digest",
    "owner",
    "binding",
    "reference",
  ] as const) {
    const f = projectTaskFixture();
    const result = await f.generate();
    const link = f.state.links.get(result.binding.runId)!;
    if (mode === "missing") f.state.links.delete(result.binding.runId);
    else {
      const corrupted = {
        ...link,
        ...(mode === "digest"
          ? { contentDigest: taskDigester.sha256("corrupt") }
          : mode === "owner"
            ? { ownerPrincipalId: "foreign" }
            : mode === "binding"
              ? { binding: { ...link.binding, runId: "foreign-run" } }
              : { reference: { ...link.reference, assetRevision: 999 } }),
      };
      f.state.links.set(
        result.binding.runId,
        mode === "digest" ? corrupted : withContentDigest(corrupted),
      );
    }
    await assert.rejects(
      f.generate(),
      error(
        "internal",
        mode === "missing"
          ? "creative_project_generation_link_missing"
          : "creative_project_store_result_invalid",
      ),
    );
    assert.equal(f.base.state.commits.length, 1);
    assert.equal(f.base.state.quoteCalls, 1);
  }
});

test("a structurally valid paid receipt from another principal is rejected independently of its digest", async () => {
  const f = projectTaskFixture();
  await f.generate();
  const saved = [...f.base.state.receipts.values()][0]!.result;
  const admission = saved.creditAdmission!;
  (saved as { creditAdmission: unknown }).creditAdmission =
    createExtensionCreditAdmission(
      {
        binding: saved.binding,
        receipt: f.base.state.commits[0]!.receipt,
        principalId: "foreign-principal",
        poolId: admission.reservation.scope.poolId,
        priceRevision: admission.reservation.priceRevision,
        quotedCredits: admission.reservation.quotedCredits,
      },
      taskDigester,
    );
  await assert.rejects(
    f.generate(),
    error("authorization", "extension_credit_account_owner_mismatch"),
  );
  assert.equal(f.base.state.commits.length, 1);
  assert.equal(f.base.state.quoteCalls, 1);
});

test("replay also rejects a different original plugin owner pin or missing and altered credit admission", async () => {
  const f = projectTaskFixture();
  const result = await f.generate();
  f.base.state.admissions.set(result.binding.runId, {
    ...f.base.state.admissions.get(result.binding.runId)!,
    principalId: "foreign",
  });
  await assert.rejects(
    f.generate(),
    error("authorization", "plugin_task_admission_owner_mismatch"),
  );
  for (const mode of ["missing", "principal"] as const) {
    const other = projectTaskFixture();
    await other.generate();
    const saved = [...other.base.state.receipts.values()][0]!.result;
    if (mode === "missing")
      delete (saved as { creditAdmission?: unknown }).creditAdmission;
    else {
      const admission = saved.creditAdmission!;
      (saved as { creditAdmission: unknown }).creditAdmission = {
        ...admission,
        reservation: {
          ...admission.reservation,
          scope: { ...admission.reservation.scope, principalId: "foreign" },
        },
      };
    }
    await assert.rejects(
      other.generate(),
      error(
        "internal",
        mode === "missing" ? "extension_credit_admission_missing" : undefined,
      ),
    );
    assert.equal(other.base.state.commits.length, 1);
  }
});
