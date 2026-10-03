import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionCanonicalJson } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { ProjectGenerationReadApplicationService } from "./project-generation-read-application-service.ts";
import { projectGenerationReadFixture } from "./project-generation-read-application-service.test-support.ts";
import {
  taskActor,
  taskDigester,
} from "./extension-plugin-task.test-support.ts";

function internal(error: unknown) {
  return error instanceof ApplicationError && error.category === "internal";
}
function denied(error: unknown) {
  return (
    error instanceof ApplicationError && error.category === "authorization"
  );
}

test("saved source derives the original execution task with no new quote or commit", async () => {
  const f = await projectGenerationReadFixture();
  const before = {
    quotes: f.f.base.state.quoteCalls,
    commits: f.f.base.state.commits.length,
  };
  const result = await f.read();
  assert.ok(result);
  assert.deepEqual(
    result.link,
    f.f.state.links.get(f.generated!.binding.runId),
  );
  assert.equal(result.task.run.runId, f.generated!.binding.runId);
  assert.equal(f.state.runReads, 2);
  assert.deepEqual(
    {
      quotes: f.f.base.state.quoteCalls,
      commits: f.f.base.state.commits.length,
    },
    before,
  );
});

test("an authorized ungenerated saved source returns null without execution task reads", async () => {
  const f = await projectGenerationReadFixture({ generated: false });
  assert.equal(await f.read(), null);
  assert.equal(f.state.runReads, 0);
  assert.equal(f.f.state.projectPermissions.length, 4);
});

test("the metadata gate precedes slot lookup for foreign principal and missing saved revision", async () => {
  const f = await projectGenerationReadFixture();
  await assert.rejects(
    f.service.getConceptGeneration(
      { ...taskActor, principalId: "foreign" },
      f.query,
    ),
  );
  await assert.rejects(
    f.service.getConceptGeneration(taskActor, { ...f.query, assetRevision: 2 }),
  );
  assert.equal(f.state.linkReads, 0);
});

test("query accepts only saved source fields and never calls an accessor", async () => {
  const f = await projectGenerationReadFixture();
  let reads = 0;
  const accessor = { ...f.query };
  Object.defineProperty(accessor, "projectId", {
    enumerable: true,
    get() {
      reads++;
      return f.query.projectId;
    },
  });
  for (const query of [
    { ...f.query, runId: "invented" },
    { ...f.query, pluginId: "foreign" },
    { ...f.query, principalId: "foreign" },
    { ...f.query, assetRevision: 0 },
    accessor,
  ])
    await assert.rejects(f.service.getConceptGeneration(taskActor, query));
  assert.equal(reads, 0);
  assert.equal(f.state.linkReads, 0);
});

test("history remains readable after archive, append and disabled execution activation", async () => {
  const f = await projectGenerationReadFixture();
  f.f.appendInput();
  f.f.archive();
  f.state.activationState = "disabled";
  const result = await f.read();
  assert.equal(result?.link.reference.assetRevision, 1);
  assert.equal(
    result?.link.assetContentDigest,
    f.f.original.assetRevision.contentDigest,
  );
});

test("current caller actor may differ from the original audit actor for the same owner", async () => {
  const f = await projectGenerationReadFixture();
  const result = await f.service.getConceptGeneration(
    { ...taskActor, actorId: "owner-new-audit-actor" },
    f.query,
  );
  assert.equal(result?.link.receipt.actorId, taskActor.actorId);
});

test("the second task read returns its latest state while original binding stays immutable", async () => {
  const f = await projectGenerationReadFixture();
  f.state.beforeOperations = (count) => {
    if (count === 1) f.state.run = { ...f.state.run!, status: "canceled" };
  };
  const result = await f.read();
  assert.equal(result?.task.run.status, "canceled");
  assert.equal(result?.link.binding.runId, f.generated!.binding.runId);
});

test("current task query/run permissions and revoked activation fail closed", async () => {
  for (const action of ["extension:query", "run:read"] as const) {
    const f = await projectGenerationReadFixture();
    f.f.base.state.denied = action;
    await assert.rejects(f.read(), denied);
  }
  const f = await projectGenerationReadFixture();
  f.state.activationState = "revoked";
  await assert.rejects(f.read(), denied);
});

test("late metadata revocation during the final task operation wait prevents delivery", async () => {
  const f = await projectGenerationReadFixture();
  f.state.beforeOperations = (count) => {
    if (count === 2) f.f.state.deniedProject = true;
  };
  await assert.rejects(f.read(), denied);
  assert.equal(f.state.operationReads, 2);
});

test("late original task permission revocation and missing receipt prevent delivery", async () => {
  const f = await projectGenerationReadFixture();
  f.state.beforeReceipt = () => {
    f.f.base.state.denied = "run:read";
  };
  await assert.rejects(f.read(), denied);
  const missing = await projectGenerationReadFixture();
  missing.state.missingReceipt = true;
  await assert.rejects(missing.read(), internal);
});

test("null results recheck the source permission after slot lookup", async () => {
  const f = await projectGenerationReadFixture({ generated: false });
  f.state.beforeLink = () => {
    f.f.state.deniedProject = true;
  };
  await assert.rejects(f.read(), denied);
});

test("self-consistent source digest, owner, binding and original receipt corruption are rejected", async () => {
  for (const patch of ["owner", "source", "binding", "receipt"] as const) {
    const f = await projectGenerationReadFixture();
    const link = structuredClone(
      f.f.state.links.get(f.generated!.binding.runId)!,
    );
    if (patch === "receipt") {
      const saved = Array.from(f.f.base.state.receipts.values())[0]!;
      saved.result = {
        ...saved.result,
        binding: { ...saved.result.binding, runId: "foreign-run" },
      };
    } else {
      const { contentDigest: _, ...body } = link;
      if (patch === "owner") body.ownerPrincipalId = "foreign";
      if (patch === "source")
        body.assetContentDigest = taskDigester.sha256("other saved prompt");
      if (patch === "binding")
        body.binding = {
          ...body.binding,
          target: { ...body.binding.target, authorityId: "foreign-target" },
        };
      f.state.returnedLink = {
        ...body,
        contentDigest: taskDigester.sha256(extensionCanonicalJson(body)),
      };
    }
    await assert.rejects(f.read(), internal);
  }
});

test("default off and method accessors fail before a call and bound ports cannot be replaced", async () => {
  const f = await projectGenerationReadFixture();
  assert.throws(
    () =>
      new ProjectGenerationReadApplicationService({
        ...f.dependencies,
        extensions: {
          ...f.extensions,
          projectGenerationReadVersion: undefined,
        },
      }),
    internal,
  );
  let getterCalls = 0;
  const accessor = { ...f.extensions };
  Object.defineProperty(accessor, "loadProjectGenerationLinkBySource", {
    enumerable: true,
    get() {
      getterCalls++;
      return f.extensions.loadProjectGenerationLinkBySource;
    },
  });
  assert.throws(
    () =>
      new ProjectGenerationReadApplicationService({
        ...f.dependencies,
        extensions: accessor,
      }),
    internal,
  );
  assert.equal(getterCalls, 0);
  f.state.beforeLink = () => {
    f.extensions.loadExtensionTurnReceipt = async () => {
      throw new Error("replaced receipt method");
    };
    f.tasks.getTask = async () => {
      throw new Error("replaced task method");
    };
    f.projects.getConceptRevision = async () => {
      throw new Error("replaced project method");
    };
  };
  assert.ok(await f.read());
});

test("caller source and actor mutations during a pending lookup use detached input", async () => {
  const f = await projectGenerationReadFixture();
  const actor = { ...taskActor };
  const query = { ...f.query };
  f.state.beforeLink = () => {
    actor.principalId = "foreign";
    query.projectId = "foreign";
    query.assetRevision = 900;
  };
  assert.ok(await f.service.getConceptGeneration(actor, query));
});
