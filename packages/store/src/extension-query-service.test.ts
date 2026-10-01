import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import {
  ApplicationError,
  ExtensionTaskApplicationService,
  type CreateExtensionTaskCommand,
  type ExtensionQueryHostPort,
  type ExtensionRegistration,
} from "@crewon/application";
import { createExtensionRunBinding } from "@crewon/domain";
import {
  actor,
  activateCommand,
  configurationServiceFixture,
  saveCommand,
} from "./extension-configuration-service.test-support.ts";
import { digest, timestamp } from "./extension-store.test-support.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";

const code =
  (...expected: string[]) =>
  (error: unknown) =>
    error instanceof ApplicationError && expected.includes(error.code);
const otherDigest = `sha256:${"b".repeat(64)}`;

/** Real admission/transactions; explicit host fixtures test port isolation, not executable readiness. */
async function fixture(t: TestContext) {
  const f = await configurationServiceFixture(t, "sqlite");
  await f.seedDeployment();
  const { configuration } = await f.service.saveConfiguration(
    actor,
    saveCommand,
  );
  await f.service.setActivation(actor, activateCommand);
  const registration = f.dependencies.catalog.resolve(configuration)!;
  const create = (queryHost?: ExtensionQueryHostPort) =>
    new ExtensionTaskApplicationService({
      ...f.dependencies,
      queryHost,
      store: f.first.parent,
      extensions: f.first.store,
      operations: f.operations,
      ids: { nextId: () => randomUUID() },
    });
  await seedThread(f.first.parent, { ...actor, threadId: "original-thread" });
  const original = await create().createTask(actor, {
    pluginId: configuration.pluginId,
    threadId: "original-thread",
    expectedThreadRevision: 1,
    idempotencyKey: "generate-original",
    intent: { kind: "generate", input: { prompt: "original image" } },
  });
  const operationId = randomUUID();
  await f.operations.reserveExternalOperation({
    tenantId: actor.tenantId,
    runId: original.binding.runId,
    bindingDigest: original.binding.bindingDigest,
    operationId,
    correlationId: operationId,
    executionId: "execution-1",
    idempotencyKey: "operation-1",
    actionDigest: digest,
    requestDigest: digest,
    createdAt: timestamp,
  });
  await seedThread(f.first.parent, { ...actor, threadId: "query-thread" });
  const command: CreateExtensionTaskCommand = {
    pluginId: configuration.pluginId,
    threadId: "query-thread",
    expectedThreadRevision: 1,
    idempotencyKey: "query-original",
    intent: { kind: "query", sourceRunId: original.binding.runId, operationId },
  };
  const queryState: {
    registration: ExtensionRegistration | null;
    resolved: Parameters<ExtensionQueryHostPort["resolveRegistration"]>[0][];
    evaluated: Parameters<ExtensionQueryHostPort["evaluate"]>[0][];
  } = { registration, resolved: [], evaluated: [] };
  const queryHost: ExtensionQueryHostPort = {
    async resolveRegistration(input) {
      queryState.resolved.push(input);
      return queryState.registration;
    },
    async evaluate(input) {
      queryState.evaluated.push(input);
      return f.state.readiness;
    },
  };
  const unwritten = async () => {
    assert.equal(await f.count("messages"), 1);
    assert.equal(await f.count("extension_run_bindings"), 1);
    assert.equal(await f.count("work_items"), 1);
  };
  return {
    ...f,
    registration,
    configuration,
    original,
    command,
    queryState,
    queryHost,
    create,
    unwritten,
  };
}

test("query resolves the exact original implementation after a current catalog switch and disable", async (t) => {
  const f = await fixture(t);
  f.state.implementationDigest = otherDigest;
  await assert.rejects(
    f.create().createTask(actor, f.command),
    code("extension_implementation_unavailable"),
  );
  await f.service.setActivation(actor, {
    ...activateCommand,
    expectedRevision: 1,
    idempotencyKey: "disabled",
    state: "disabled",
    agentVersionId: null,
  });
  f.state.catalogAvailable = false;
  const currentEvaluated = f.state.evaluated.length;
  const saved = await f.create(f.queryHost).createTask(actor, f.command);
  assert.deepEqual(f.queryState.resolved, [
    {
      actor,
      identity: {
        pluginId: f.configuration.pluginId,
        pluginVersion: f.configuration.pluginVersion,
        manifestDigest: f.configuration.manifestDigest,
        implementationDigest: f.configuration.implementationDigest,
      },
    },
  ]);
  assert.ok(Object.isFrozen(f.queryState.resolved[0]));
  assert.ok(Object.isFrozen(f.queryState.resolved[0]!.actor));
  assert.ok(Object.isFrozen(f.queryState.resolved[0]!.identity));
  assert.equal(f.state.evaluated.length, currentEvaluated);
  assert.deepEqual(f.queryState.evaluated[0]?.configuration, f.configuration);
  assert.deepEqual(
    f.queryState.evaluated[0]?.expectedTarget,
    f.original.binding.target,
  );
  assert.ok(Object.isFrozen(f.queryState.evaluated[0]?.expectedTarget));
  assert.ok(Object.isFrozen(f.queryState.evaluated[0]));
  assert.deepEqual(saved.binding.target, f.original.binding.target);
  assert.equal(
    saved.binding.configurationDigest,
    f.original.binding.configurationDigest,
  );
  assert.deepEqual(saved.binding.source, {
    runId: f.original.binding.runId,
    bindingDigest: f.original.binding.bindingDigest,
    operationId: (f.command.intent as { operationId: string }).operationId,
  });
  const replay = await f.create(f.queryHost).createTask(actor, f.command);
  assert.equal(replay.turn.disposition, "replayed");
  assert.equal(f.queryState.resolved.length, 1);
  assert.equal(f.queryState.evaluated.length, 1);
});

test("generate never consults the historical query port or falls back to an old implementation", async (t) => {
  const f = await fixture(t);
  f.state.implementationDigest = otherDigest;
  await assert.rejects(
    f.create(f.queryHost).createTask(actor, {
      ...f.command,
      idempotencyKey: "new-generation",
      intent: { kind: "generate", input: { prompt: "new image" } },
    }),
    code("extension_implementation_unavailable"),
  );
  assert.equal(f.queryState.resolved.length, 0);
  assert.equal(f.queryState.evaluated.length, 0);
  await f.unwritten();
});

test("missing query port preserves the existing current-catalog and current-host query behavior", async (t) => {
  const f = await fixture(t);
  const before = f.state.evaluated.length;
  const saved = await f.create().createTask(actor, f.command);
  assert.equal(f.state.evaluated.length, before + 1);
  assert.equal(
    Object.hasOwn(f.state.evaluated.at(-1)!, "expectedTarget"),
    false,
  );
  assert.equal(saved.binding.source?.runId, f.original.binding.runId);
  assert.equal(f.queryState.resolved.length, 0);
});

test("query metadata must match all pinned fields and its independently recomputed manifest hash", async (t) => {
  for (const change of [
    "missing",
    "plugin",
    "version",
    "manifest digest",
    "implementation",
    "manifest bytes",
    "extra field",
    "accessor",
  ] as const) {
    await t.test(change, async (subtest) => {
      const f = await fixture(subtest);
      const value = { ...structuredClone(f.registration) };
      if (change === "missing") f.queryState.registration = null;
      else if (change === "plugin")
        value.manifest = { ...value.manifest, pluginId: "crewon.other" };
      else if (change === "version")
        value.manifest = { ...value.manifest, version: "0.2.0" };
      else if (change === "manifest digest") value.manifestDigest = otherDigest;
      else if (change === "implementation")
        value.implementationDigest = otherDigest;
      else if (change === "manifest bytes")
        value.manifest = { ...value.manifest, title: "modified title" };
      else if (change === "extra field")
        Object.assign(value, { origin: "http://127.0.0.1:1234" });
      else if (change === "accessor")
        Object.defineProperty(value, "manifest", {
          enumerable: true,
          get: () => assert.fail("getter must not run"),
        });
      if (change !== "missing") f.queryState.registration = value;
      await assert.rejects(
        f.create(f.queryHost).createTask(actor, f.command),
        code(
          change === "missing"
            ? "extension_implementation_unavailable"
            : "extension_query_registration_invalid",
        ),
      );
      assert.equal(f.queryState.evaluated.length, 0);
      await f.unwritten();
    });
  }
});

test("source Run and binding identity/owner/route mismatches contact no query host and admit nothing", async (t) => {
  for (const change of [
    "run tenant",
    "run space",
    "run id",
    "run actor",
    "binding tenant",
    "binding space",
    "binding run",
    "binding actor",
    "binding thread",
    "binding plugin",
    "binding source",
    "agentVersionId",
    "authorityId",
    "runtimeGeneration",
    "policySnapshotId",
    "workspaceBindingId",
  ] as const) {
    await t.test(change, async (subtest) => {
      const f = await fixture(subtest);
      if (change.startsWith("run ")) {
        const load = f.first.parent.loadRunInSpace.bind(f.first.parent);
        const key = {
          "run tenant": "tenantId",
          "run space": "spaceId",
          "run id": "runId",
          "run actor": "createdByActorId",
        }[change as "run tenant"];
        subtest.mock.method(
          f.first.parent,
          "loadRunInSpace",
          async (input: Parameters<typeof load>[0]) => {
            const value = await load(input);
            return value === null ? null : { ...value, [key]: "foreign" };
          },
        );
      } else {
        const raw = { ...structuredClone(f.original.binding) };
        if (change === "binding tenant") raw.tenantId = "foreign";
        else if (change === "binding space") raw.spaceId = "foreign";
        else if (change === "binding run") raw.runId = "foreign";
        else if (change === "binding actor") raw.actorId = "foreign";
        else if (change === "binding thread") raw.threadId = "foreign";
        else if (change === "binding plugin") raw.pluginId = "crewon.other";
        else if (change === "binding source")
          raw.source = {
            runId: "nested-query",
            bindingDigest: digest,
            operationId: randomUUID(),
          };
        else raw.target = { ...raw.target, [change]: "foreign" };
        const binding = createExtensionRunBinding(raw, f.dependencies.digester);
        subtest.mock.method(
          f.first.store,
          "loadExtensionRunBinding",
          async () => binding,
        );
      }
      await assert.rejects(
        f.create(f.queryHost).createTask(actor, f.command),
        code(
          "extension_query_source_invalid",
          "extension_query_source_not_found",
        ),
      );
      assert.equal(f.queryState.resolved.length, 0);
      assert.equal(f.queryState.evaluated.length, 0);
      await f.unwritten();
    });
  }
});

test("source operation must echo the exact tenant, original Run, binding and operation ID", async (t) => {
  for (const key of [
    "tenantId",
    "runId",
    "bindingDigest",
    "operationId",
  ] as const) {
    await t.test(key, async (subtest) => {
      const f = await fixture(subtest);
      const load = f.operations.loadExternalOperation.bind(f.operations);
      subtest.mock.method(
        f.operations,
        "loadExternalOperation",
        async (input: Parameters<typeof load>[0]) => {
          const value = await load(input);
          return value === null
            ? null
            : {
                ...value,
                [key]: key === "bindingDigest" ? otherDigest : "foreign",
              };
        },
      );
      await assert.rejects(
        f.create(f.queryHost).createTask(actor, f.command),
        code("external_operation_identity_conflict"),
      );
      assert.equal(f.queryState.resolved.length, 0);
      await f.unwritten();
    });
  }
});

test("query authorization and revocation fail before resolving any historical registration", async (t) => {
  for (const denied of [
    "extension:query",
    "run:read",
    "thread:message:append",
    "run:create",
    "revoked",
  ] as const) {
    await t.test(denied, async (subtest) => {
      const f = await fixture(subtest);
      if (denied === "revoked")
        await f.service.setActivation(actor, {
          ...activateCommand,
          expectedRevision: 1,
          idempotencyKey: "revoked",
          state: "revoked",
          agentVersionId: null,
        });
      else f.state.denied = denied;
      await assert.rejects(
        f.create(f.queryHost).createTask(actor, f.command),
        code(
          denied === "revoked"
            ? "extension_access_revoked"
            : "authorization_denied",
        ),
      );
      assert.equal(f.queryState.resolved.length, 0);
      assert.equal(f.queryState.evaluated.length, 0);
      await f.unwritten();
    });
  }
});

test("foreign activation scope is rejected before consulting the historical query port", async (t) => {
  for (const key of ["tenantId", "spaceId", "pluginId"] as const) {
    await t.test(key, async (subtest) => {
      const f = await fixture(subtest);
      const load = f.first.store.loadExtensionActivation.bind(f.first.store);
      subtest.mock.method(
        f.first.store,
        "loadExtensionActivation",
        async (input: Parameters<typeof load>[0]) => {
          const value = await load(input);
          return value === null
            ? null
            : {
                ...value,
                [key]: key === "pluginId" ? "crewon.other" : "foreign",
              };
        },
      );
      await assert.rejects(
        f.create(f.queryHost).createTask(actor, f.command),
        code("extension_activation_scope_mismatch"),
      );
      assert.equal(f.queryState.resolved.length, 0);
      await f.unwritten();
    });
  }
});

test("historical metadata is copied before evaluate and full readiness target must remain pinned", async (t) => {
  const f = await fixture(t);
  const returned = structuredClone(f.registration);
  f.queryState.registration = returned;
  const queryHost: ExtensionQueryHostPort = {
    ...f.queryHost,
    evaluate: async (input) => {
      Object.assign(returned, { implementationDigest: otherDigest });
      assert.equal(
        input.registration.implementationDigest,
        f.configuration.implementationDigest,
      );
      assert.ok(Object.isFrozen(input.registration));
      assert.ok(Object.isFrozen(input.registration.manifest));
      return {
        outcome: "ready",
        target: {
          ...f.original.binding.target,
          materializationDigest: otherDigest,
        },
      };
    },
  };
  await assert.rejects(
    f.create(queryHost).createTask(actor, f.command),
    code("extension_execution_target_mismatch"),
  );
  await f.unwritten();
});

test("permission revoked while restoring or evaluating history cannot admit a query Turn", async (t) => {
  for (const phase of ["resolve", "evaluate"] as const) {
    for (const denied of ["extension:query", "run:read"] as const) {
      await t.test(`${phase}: ${denied}`, async (subtest) => {
        const f = await fixture(subtest);
        const queryHost: ExtensionQueryHostPort = {
          resolveRegistration: async (input) => {
            const registration = await f.queryHost.resolveRegistration(input);
            if (phase === "resolve") f.state.denied = denied;
            return registration;
          },
          evaluate: async (input) => {
            const readiness = await f.queryHost.evaluate(input);
            if (phase === "evaluate") f.state.denied = denied;
            return readiness;
          },
        };
        await assert.rejects(
          f.create(queryHost).createTask(actor, f.command),
          code("authorization_denied"),
        );
        assert.equal(
          f.queryState.evaluated.length,
          phase === "resolve" ? 0 : 1,
        );
        await f.unwritten();
      });
    }
  }
});

test("query actor, command and pinned registration identity remain snapshots across asynchronous restoration", async (t) => {
  const f = await fixture(t);
  let entered!: () => void;
  const restoring = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const queryHost: ExtensionQueryHostPort = {
    ...f.queryHost,
    resolveRegistration: async (input) => {
      entered();
      await paused;
      assert.deepEqual(input.actor, actor);
      assert.equal(
        input.identity.implementationDigest,
        f.configuration.implementationDigest,
      );
      return f.queryHost.resolveRegistration(input);
    },
  };
  const mutableActor = { ...actor };
  const mutableCommand = { ...f.command, intent: { ...f.command.intent } };
  const pending = f.create(queryHost).createTask(mutableActor, mutableCommand);
  await restoring;
  mutableActor.principalId = "forged-principal";
  mutableActor.tenantId = "foreign-tenant";
  mutableCommand.threadId = "foreign-thread";
  Object.assign(mutableCommand.intent, {
    sourceRunId: "foreign-run",
    operationId: randomUUID(),
  });
  resume();
  const saved = await pending;
  assert.equal(saved.binding.source?.runId, f.original.binding.runId);
  assert.equal(saved.binding.actorId, actor.actorId);
  assert.equal(saved.binding.tenantId, actor.tenantId);
  assert.equal(saved.binding.threadId, f.command.threadId);
});
