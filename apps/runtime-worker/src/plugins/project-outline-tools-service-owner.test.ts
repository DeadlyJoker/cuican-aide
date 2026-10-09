import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ProjectStructuredOutlineApplicationService } from "@crewon/application";
import { creativeStoreDigester } from "../../../../packages/store/src/creative-project-store-records.ts";
import { outlineToolsOwnerFixture } from "./project-outline-tools-service-owner.test-support.ts";

test("outline owner uses the original Worker receipt to save one structured candidate and cold replay", async (t) => {
  const f = await outlineToolsOwnerFixture(t),
    owner = f.owner();
  const result = await f.invoke(owner, () =>
    f.service(owner).saveCandidate({
      command: f.command,
      request: f.portableRequest,
    }),
  );
  assert.equal(result.disposition, "committed");
  assert.equal(result.contentRevision, 1);
  const view = await f
    .application()
    .getOutline(f.actor, { projectId: result.projectId });
  assert.ok(view);
  assert.equal(view.artifact.selectedContentRevision, null);
  assert.equal(view.artifact.locked, false);
  assert.equal(
    view.latestRevision.schemaVersion,
    "crewon.project-text-revision.v2",
  );
  await owner.close();
  const next = f.owner();
  const replay = await f.invoke(next, () =>
    f.service(next).saveCandidate({
      command: f.command,
      request: f.portableRequest,
    }),
  );
  assert.equal(replay.disposition, "replayed");
  assert.equal(replay.contentDigest, result.contentDigest);
  assert.equal(await f.count("project_text_revisions"), 1);
});

test("outline owner rejects setup calls, copied commands, changed input and legacy operation", async (t) => {
  const f = await outlineToolsOwnerFixture(t),
    owner = f.owner(),
    service = f.service(owner);
  await assert.rejects(
    service.saveCandidate({
      command: f.command,
      request: f.portableRequest,
    }),
  );
  await assert.rejects(owner.withInvocation(f.invocation, async () => {}));
  await assert.rejects(
    f.invoke(owner, () =>
      service.saveCandidate({
        command: structuredClone(f.command),
        request: f.portableRequest,
      }),
    ),
  );
  await assert.rejects(
    f.invoke(owner, () =>
      service.saveCandidate({
        command: f.command,
        request: {
          ...f.portableRequest,
          expectedArtifactRevision: 1,
        },
      }),
    ),
  );
  const incompatible = f.owner({
    tools: f.dependencies.tools.map((tool) => ({
      ...tool,
      operationId: "outline_save",
    })),
  });
  await assert.rejects(
    f.invoke(incompatible, () =>
      f.service(incompatible).saveCandidate({
        command: f.command,
        request: f.portableRequest,
      }),
    ),
  );
  assert.equal(await f.count("project_text_revisions"), 0);
});

test("outline owner requires independently current service and actor policy", async (t) => {
  const f = await outlineToolsOwnerFixture(t),
    owner = f.owner();
  f.controls.service = false;
  await assert.rejects(
    f.invoke(owner, () =>
      f.service(owner).saveCandidate({
        command: f.command,
        request: f.portableRequest,
      }),
    ),
  );
  f.controls.service = true;
  f.controls.policy = false;
  await assert.rejects(
    f.invoke(owner, () =>
      f.service(owner).saveCandidate({
        command: f.command,
        request: f.portableRequest,
      }),
    ),
  );
  f.controls.policy = true;
  const impostor = f.owner({
    async resolveActor() {
      return { ...f.actor, actorId: "other-actor" };
    },
  });
  await assert.rejects(
    f.invoke(impostor, () =>
      f.service(impostor).saveCandidate({
        command: f.command,
        request: f.portableRequest,
      }),
    ),
  );
  assert.equal(await f.count("project_text_revisions"), 0);
});

test("outline owner rechecks the independent service inside COMMIT and rolls back withdrawal", async (t) => {
  const f = await outlineToolsOwnerFixture(t),
    owner = f.owner();
  f.controls.beforeTransaction = () => {
    f.controls.service = false;
  };
  await assert.rejects(
    f.invoke(owner, () =>
      f.service(owner).saveCandidate({
        command: f.command,
        request: f.portableRequest,
      }),
    ),
  );
  assert.ok(f.controls.checks > 0);
  assert.equal(await f.count("project_text_revisions"), 0);
  assert.equal(await f.count("project_text_mutation_receipts"), 0);
});

test("outline owner cannot write on cancellation, expired lease or after retirement", async (t) => {
  const f = await outlineToolsOwnerFixture(t),
    owner = f.owner();
  await assert.rejects(
    f.invoke(
      owner,
      () =>
        f.service(owner).saveCandidate({
          command: f.command,
          request: f.portableRequest,
        }),
      "cancel",
    ),
  );
  const expired = f.owner({
    now: () => new Date(Date.parse(f.command.executionLease.expiresAt) + 1),
  });
  await assert.rejects(
    f.invoke(expired, () =>
      f.service(expired).saveCandidate({
        command: f.command,
        request: f.portableRequest,
      }),
    ),
  );
  await owner.close();
  await assert.rejects(
    f.invoke(owner, () =>
      f.service(owner).saveCandidate({
        command: f.command,
        request: f.portableRequest,
      }),
    ),
  );
  assert.equal(await f.count("project_text_revisions"), 0);
});

test("outline owner preserves the durable ACK when cancellation arrives after original COMMIT", async (t) => {
  const f = await outlineToolsOwnerFixture(t),
    store = f.store;
  const outlines = new ProjectStructuredOutlineApplicationService({
    store: {
      loadOutline: store.loadOutline.bind(store),
      loadArtifact: store.loadArtifact.bind(store),
      loadStructuredRevision: store.loadStructuredRevision.bind(store),
      listStructuredRevisions: store.listStructuredRevisions.bind(store),
      loadStructuredMutationReceipt:
        store.loadStructuredMutationReceipt.bind(store),
      commitStructuredOutlineSelection:
        store.commitStructuredOutlineSelection.bind(store),
      async commitStructuredOutlineCandidate(input, options) {
        const result = await store.commitStructuredOutlineCandidate(
          input,
          options,
        );
        f.controls.service = false;
        f.signal.abort(new Error("named_post_commit_cancel"));
        return result;
      },
    },
    projects: f.parent.creativeProjectStore(),
    foundations: f.parent.projectFoundationStore(),
    authorization: f.dependencies.authorization,
    clock: { now: () => new Date().toISOString() },
    ids: { nextId: () => randomUUID() },
    digester: creativeStoreDigester,
  });
  const owner = f.owner({ outlines });
  const result = await f.invoke(owner, () =>
    f.service(owner).saveCandidate({
      command: f.command,
      request: f.portableRequest,
    }),
  );
  assert.equal(result.disposition, "committed");
  assert.equal(await f.count("project_text_revisions"), 1);
  assert.equal(await f.count("project_text_mutation_receipts"), 1);
});

test("outline owner close drains physical dispatch before retirement and prevents a pre-COMMIT save", async (t) => {
  const f = await outlineToolsOwnerFixture(t);
  const entered = deferred(),
    release = deferred();
  const owner = f.owner({
    async authorizeOutlineService(signal) {
      entered.resolve();
      await release.promise;
      signal.throwIfAborted();
    },
  });
  const saving = f.invoke(owner, () =>
    f.service(owner).saveCandidate({
      command: f.command,
      request: f.portableRequest,
    }),
  );
  const rejection = assert.rejects(saving);
  await entered.promise;
  const closing = owner.close();
  assert.equal(owner.canRetire(), false);
  release.resolve();
  await rejection;
  await closing;
  assert.ok(owner.canRetire());
  assert.equal(await f.count("project_text_revisions"), 0);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("outline context reads the original Foundation parameters through a genuine read receipt without saving", async (t) => {
  const f = await outlineToolsOwnerFixture(t),
    owner = f.owner(),
    read = await f.contextInvocation();
  const result = await read.invoke(owner, () =>
    f
      .service(owner)
      .getContext({ command: read.command, request: read.request }),
  );
  assert.equal(
    result.context.foundationRevision,
    f.foundation.foundation.revision,
  );
  assert.equal(result.context.briefRevision, f.brief.briefRevision);
  assert.deepEqual(
    JSON.parse(result.page.text),
    f.foundation.foundation.parameters,
  );
  assert.equal(result.page.nextOffset, null);
  assert.equal(await f.count("project_text_revisions"), 0);
  assert.equal(await f.count("project_text_mutation_receipts"), 0);
  await assert.rejects(
    read.invoke(owner, () =>
      f
        .service(owner)
        .getContext({
          command: structuredClone(read.command),
          request: read.request,
        }),
    ),
  );
  await assert.rejects(
    read.invoke(owner, () =>
      f
        .service(owner)
        .getContext({
          command: read.command,
          request: { ...read.request, projectId: "other-project" },
        }),
    ),
  );
  const stale = await f.contextInvocation({
    ...read.request,
    expectedFoundationRevision: result.context.foundationRevision + 1,
  });
  await assert.rejects(
    stale.invoke(owner, () =>
      f
        .service(owner)
        .getContext({ command: stale.command, request: stale.request }),
    ),
  );
});

test("outline context refuses a Foundation revision that changes while the read is in flight", async (t) => {
  const f = await outlineToolsOwnerFixture(t),
    read = await f.contextInvocation();
  let loads = 0;
  const original = f.dependencies.foundations.loadFoundation.bind(
    f.dependencies.foundations,
  );
  const owner = f.owner({
    foundations: {
      async loadFoundation(input) {
        const result = await original(input);
        assert.ok(result);
        return ++loads === 1
          ? result
          : { ...result, revision: result.revision + 1 };
      },
    },
  });
  await assert.rejects(
    read.invoke(owner, () =>
      f
        .service(owner)
        .getContext({ command: read.command, request: read.request }),
    ),
  );
  assert.equal(await f.count("project_text_revisions"), 0);
});
