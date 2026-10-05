import assert from "node:assert/strict";
import test from "node:test";
import { extensionCanonicalJson } from "@crewon/domain";
import { projectToolsOwnerFixture } from "./project-tools-service-owner.test-support.ts";
import { deferred, tick } from "./plugin-tool-runtime-adapter.test-support.ts";

const request = { title: "夜航", briefText: "摄影师收到雨夜来信。" };

test("real admitted command creates a project once; same receipt replay survives a new service owner", async (t) => {
  const f = await projectToolsOwnerFixture(t),
    operation = await f.prepareOperation("project_create", request);
  const first = f.owner();
  const saved = await f.invoke(first, operation, (command) =>
    f.service(first).createProject({ command, request }),
  );
  assert.equal(saved.disposition, "committed");
  assert.equal(saved.project.title, request.title);
  assert.equal(Object.hasOwn(saved.brief, "text"), false);
  assert.ok(f.controls.transactionChecks > 0);
  await first.close();
  const second = f.owner();
  const replay = await f.invoke(second, operation, (command) =>
    f.service(second).createProject({ command, request }),
  );
  assert.equal(replay.disposition, "replayed");
  assert.deepEqual(replay.project, saved.project);
  assert.deepEqual(replay.brief, saved.brief);
  const counts = await f.counts();
  assert.equal(counts.creative_projects, 2); // Original admitted-generation project plus the one Tool creation.
  assert.equal(counts.extension_external_operations, 0);
});

test("service possession, copied commands, changed input and cross-Run contexts cannot write", async (t) => {
  const f = await projectToolsOwnerFixture(t),
    operation = await f.prepareOperation("project_create", request),
    owner = f.owner(),
    service = f.service(owner);
  const before = await f.counts();
  await assert.rejects(
    service.createProject({ command: operation.command, request }),
    /authority_denied/,
  );
  await assert.rejects(
    f.invoke(
      owner,
      operation,
      (command) => service.createProject({ command, request }),
      { copied: true },
    ),
    /authority_denied/,
  );
  await assert.rejects(
    f.invoke(owner, operation, (command) =>
      service.createProject({
        command,
        request: { ...request, briefText: "swapped" },
      }),
    ),
    /authority_denied/,
  );
  const foreign = f.owner({
    context: { ...f.context, run: { ...f.context.run, runId: "foreign-run" } },
    admission: { ...f.admission, runId: "foreign-run" },
  });
  await assert.rejects(
    f.invoke(foreign, operation, (command) =>
      f.service(foreign).createProject({ command, request }),
    ),
    /authority_denied/,
  );
  assert.deepEqual(await f.counts(), before);
});

test("expired lease, actor replacement and package/selection drift reject before any metadata commit", async (t) => {
  const f = await projectToolsOwnerFixture(t),
    operation = await f.prepareOperation("project_create", request),
    before = await f.counts();
  const expired = f.owner({
    now: () => new Date(Date.parse(operation.claim.lease.expiresAt) + 1),
  });
  await assert.rejects(
    f.invoke(expired, operation, (command) =>
      f.service(expired).createProject({ command, request }),
    ),
    /authority_denied/,
  );
  const owner = f.owner();
  f.controls.actor = { ...f.actor, principalId: "other-principal" };
  await assert.rejects(
    f.invoke(owner, operation, (command) =>
      f.service(owner).createProject({ command, request }),
    ),
    /authority_denied/,
  );
  f.controls.actor = f.actor;
  const drift = f.owner({
    installations: {
      loadSelection: async () => ({
        ...f.enabled.selection,
        state: "disabled",
      }),
      loadPackage: (value) => f.installs.loadPackage(value),
    },
  });
  await assert.rejects(
    f.invoke(drift, operation, (command) =>
      f.service(drift).createProject({ command, request }),
    ),
    /authority_denied/,
  );
  const packageDrift = f.owner({
    installations: {
      loadSelection: (value) => f.installs.loadSelection(value),
      loadPackage: async () => ({
        ...f.installed.package,
        publisherId: "different.publisher",
      }),
    },
  });
  await assert.rejects(
    f.invoke(packageDrift, operation, (command) =>
      f.service(packageDrift).createProject({ command, request }),
    ),
    /authority_denied/,
  );
  assert.deepEqual(await f.counts(), before);
});

test("transaction PDP withdrawal denies original project mutation without forging task authority", async (t) => {
  const f = await projectToolsOwnerFixture(t),
    operation = await f.prepareOperation("project_create", request),
    owner = f.owner(),
    before = await f.counts();
  f.controls.beforeTransaction = () => {
    f.state.policy = false;
  };
  await assert.rejects(
    f.invoke(owner, operation, (command) =>
      f.service(owner).createProject({ command, request }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error && error.cause instanceof Error);
      assert.match(error.cause.message, /authority_denied/);
      return true;
    },
  );
  assert.deepEqual(await f.counts(), before);
});

test("close withdraws immediately and physically joins the delegated runtime and started host requests", async (t) => {
  const f = await projectToolsOwnerFixture(t),
    operation = await f.prepareOperation("project_create", request),
    owner = f.owner();
  const physical = deferred(),
    entered = deferred(),
    runtime = deferred();
  f.controls.beforeCurrent = async () => {
    entered.resolve();
    await physical.promise;
  };
  let late: typeof operation.command | undefined;
  const active = f.invoke(owner, operation, async (command) => {
    late = command;
    const rejected = assert.rejects(
      f.service(owner).createProject({ command, request }),
      /authority_denied/,
    );
    await runtime.promise;
    await rejected;
  });
  await entered.promise;
  assert.equal(owner.canRetire(), false);
  let joined = false;
  const close = owner.close().then(() => {
    joined = true;
  });
  await assert.rejects(
    f.service(owner).createProject({ command: late, request }),
    /authority_denied/,
  );
  await tick();
  assert.equal(joined, false);
  physical.resolve();
  await tick();
  assert.equal(joined, false);
  runtime.resolve();
  await active;
  await close;
  assert.equal(owner.canRetire(), true);
  assert.equal(joined, true);
  assert.equal((await f.counts()).creative_projects, 1);
});

test("declared tool effect/capability cannot borrow project mutation through another tool", async (t) => {
  const f = await projectToolsOwnerFixture(t),
    operation = await f.prepareOperation("project_create", request);
  const owner = f.owner({
    tools: f.tools.map((tool) =>
      tool.operationId === "project_create"
        ? { ...tool, capability: "workspace.write" }
        : tool,
    ),
  });
  await assert.rejects(
    f.invoke(owner, operation, (command) =>
      f.service(owner).createProject({ command, request }),
    ),
    /authority_denied/,
  );
  assert.equal((await f.counts()).creative_projects, 1);
  assert.equal(
    extensionCanonicalJson(operation.request),
    extensionCanonicalJson(request),
  );
});

test("real project reads expose metadata; immutable Unicode content is paged exactly under current PDP", async (t) => {
  const f = await projectToolsOwnerFixture(t),
    owner = f.owner(),
    service = f.service(owner);
  const projectId = f.reference.projectId;
  const project = await f.projects.getProject(f.actor, { projectId });
  const source = '\t🚀界"\\\n'.repeat(500);
  const appended = await f.projects.appendBrief(f.actor, {
    projectId,
    expectedProjectRevision: project.revision,
    text: source,
    idempotencyKey: "named-human-long-brief",
  });
  const readRequest = { projectId };
  const read = await f.prepareRead("readProject", readRequest);
  const metadata = await f.invoke(owner, read, (command) =>
    service.readProject({ command, request: readRequest }),
  );
  assert.equal(metadata.brief?.contentDigest, appended.brief.contentDigest);
  assert.equal(Object.hasOwn(metadata.brief!, "text"), false);
  assert.equal(JSON.stringify(metadata).includes(source), false);
  let offset = 0,
    restored = "";
  do {
    const request = {
      projectId,
      source: {
        kind: "brief" as const,
        briefRevision: appended.brief.briefRevision,
      },
      offset,
    };
    const operation = await f.prepareRead("readContent", request);
    const chunk = await f.invoke(owner, operation, (command) =>
      service.readContent({ command, request }),
    );
    assert.equal(chunk.contentDigest, appended.brief.contentDigest);
    assert.ok(Array.from(chunk.text).length <= 1024);
    restored += chunk.text;
    if (chunk.nextOffset === null) break;
    offset = chunk.nextOffset;
  } while (true);
  assert.equal(restored, source);
  f.state.policy = false;
  await assert.rejects(
    f.invoke(owner, read, (command) =>
      service.readProject({ command, request: readRequest }),
    ),
    /forbidden|denied/,
  );
});

test("maximum confirmed brief write returns bounded metadata ACK without echoing its body", async (t) => {
  const f = await projectToolsOwnerFixture(t),
    owner = f.owner();
  const request = { title: "🚀".repeat(160), briefText: '"'.repeat(8192) };
  const operation = await f.prepareOperation("project_create", request);
  const result = await f.invoke(owner, operation, (command) =>
    f.service(owner).createProject({ command, request }),
  );
  assert.equal(result.disposition, "committed");
  assert.ok(
    Buffer.byteLength(
      JSON.stringify({ resultJson: JSON.stringify(result) }),
      "utf8",
    ) <= 8192,
  );
  assert.equal(Object.hasOwn(result.brief, "text"), false);
  const brief = await f.projects.getBrief(f.actor, {
    projectId: result.project.projectId,
    briefRevision: result.brief.briefRevision,
  });
  assert.equal(brief.text, request.briefText);
});
