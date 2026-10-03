import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePluginPackageDescriptor,
  parsePluginUiLease,
} from "@crewon/contracts/plugins";
import {
  generationReadBridgeFixture,
  generationReadResponse,
} from "./plugin-project-generation-read-action-bridge.test-support.ts";
import {
  PluginProjectGenerationReadActionBridge,
  isPluginProjectGenerationReadActionBridge,
} from "./plugin-project-generation-read-action-bridge.ts";
import {
  assertPluginUiHostServiceAvailability,
  assertUiOnlyServiceDeclarations,
} from "./plugin-ui-host-service-availability.ts";
import {
  registerProjectGenerationHostAvailability,
  hasProjectGenerationHostAvailability,
} from "./plugin-project-generation-host-availability.ts";

test("read bridge returns null and detached verified original indices under the actual source invocation", async () => {
  const f = generationReadBridgeFixture();
  assert.deepEqual(await f.invoke(), { generation: null });
  f.state.output = generationReadResponse();
  const response = await f.invoke();
  assert.deepEqual(response, f.state.output);
  assert.notEqual(response, f.state.output);
  assert.equal(f.state.last!.context.package.pluginId, f.publication.pluginId);
  assert.deepEqual(f.state.last!.request, {
    projectId: "project-a",
    assetId: "asset-a",
    assetRevision: 1,
  });
  assert.ok(f.state.currentCalls >= 4);
  assert.ok(isPluginProjectGenerationReadActionBridge(f.bridge));
  assert.equal(
    isPluginProjectGenerationReadActionBridge({ ...f.bridge }),
    false,
  );
});

test("read family never falls through ordinary task/metadata dispatch, including unknown versions", async () => {
  const f = generationReadBridgeFixture();
  for (const action of [
    "crewon.project-generation-reads",
    "crewon.project-generation-reads.v2.getConceptGeneration",
    "crewon.project-generation-reads.v1.generateConcept",
  ]) {
    await assert.rejects(
      f.invoke({ ...f.context(), action }),
      /read_action_invalid/u,
    );
  }
  assert.deepEqual(
    await f.actions.invoke({ ...f.context(), action: "ordinary.read" }),
    { ordinary: true },
  );
  assert.equal(f.state.fallbacks, 1);
  assert.equal(f.state.calls, 0);
});

test("fake context and accessor source/input are rejected without evaluating getters or reading history", async () => {
  const f = generationReadBridgeFixture();
  await assert.rejects(
    f.actions.invoke(f.context()),
    /plugin_ui_invocation_unavailable/u,
  );
  let evaluated = 0;
  for (const field of ["actor", "input"]) {
    const input = f.context();
    Object.defineProperty(input, field, {
      enumerable: true,
      get() {
        evaluated++;
        throw new Error("must_not_evaluate");
      },
    });
    await assert.rejects(f.invoke(input));
  }
  assert.equal(evaluated, 0);
  assert.equal(f.state.calls, 0);
});

test("actual package, selection, read requirement and module contribution must match the publication", async () => {
  const f = generationReadBridgeFixture();
  for (const mutate of [
    (input: ReturnType<typeof f.context>) => ({
      ...input,
      package: { ...input.package, packageDigest: `sha256:${"b".repeat(64)}` },
    }),
    (input: ReturnType<typeof f.context>) => ({
      ...input,
      selection: { ...input.selection, revision: input.selection.revision + 1 },
    }),
    (input: ReturnType<typeof f.context>) => ({
      ...input,
      lease: parsePluginUiLease({
        ...input.lease,
        descriptor: parsePluginPackageDescriptor({
          ...f.descriptor,
          requires: [],
        }),
      }),
    }),
    (input: ReturnType<typeof f.context>) => ({
      ...input,
      lease: parsePluginUiLease({
        ...input.lease,
        descriptor: parsePluginPackageDescriptor({
          ...f.descriptor,
          contributions: [
            {
              id: "workbench",
              kind: "module",
              slot: "main.content",
              title: "Mismatch",
            },
            {
              id: "other",
              kind: "module",
              slot: "main.content",
              title: "Other",
            },
          ],
        }),
        contributionId: "other",
      }),
    }),
  ])
    await assert.rejects(f.invoke(mutate(f.context())));
  assert.equal(f.state.calls, 0);
});

test("captured adapter receiver/input/publications cannot be replaced during an awaited read", async () => {
  const f = generationReadBridgeFixture();
  const held = f.deferred(),
    entered = f.deferred();
  f.state.beforeRead = async () => {
    entered.resolve();
    await held.promise;
  };
  const input = f.context();
  const pending = f.invoke(input);
  await entered.promise;
  (f.reads as { getConceptGeneration: unknown }).getConceptGeneration =
    async () => {
      throw new Error("replaced");
    };
  f.publication.packageDigest = `sha256:${"b".repeat(64)}`;
  held.resolve();
  assert.deepEqual(await pending, { generation: null });
  f.state.beforeRead = undefined;
  assert.deepEqual(await f.invoke(), { generation: null });
  assert.equal(f.state.calls, 2);
});

test("mutated input while current authorization awaits is rejected before original storage read", async () => {
  const f = generationReadBridgeFixture();
  const held = f.deferred();
  const input = f.context();
  const { registerPluginUiInvocation } = await import(
    "../../application/src/plugin-ui-invocation-authority.ts"
  );
  const dispose = registerPluginUiInvocation(
    input,
    () => held.promise,
    () => {},
  );
  const pending = f.actions.invoke(input);
  (input.input as { assetRevision: number }).assetRevision = 2;
  held.resolve();
  await assert.rejects(pending, /read_context_changed/u);
  dispose();
  assert.equal(f.state.calls, 0);
});

for (const withdrawal of ["close", "expiry", "revocation"] as const)
  test(`pending ordinary read rejects after ${withdrawal}, without durable acknowledgement bypass`, async () => {
    const f = generationReadBridgeFixture();
    const held = f.deferred(),
      entered = f.deferred();
    f.state.beforeRead = async () => {
      entered.resolve();
      await held.promise;
    };
    const pending = f.invoke();
    await entered.promise;
    let close: Promise<void> | undefined;
    if (withdrawal === "close") close = f.bridge.close();
    else if (withdrawal === "expiry") f.state.open = false;
    else f.state.allow = false;
    held.resolve();
    await assert.rejects(pending);
    await close;
  });

test("one actual invocation shares its pending read and close withdraws new availability", async () => {
  const f = generationReadBridgeFixture();
  const held = f.deferred();
  f.state.beforeRead = () => held.promise;
  const input = f.context(),
    dispose = f.register(input);
  const first = f.actions.invoke(input),
    second = f.actions.invoke(input);
  assert.equal(first, second);
  held.resolve();
  await first;
  dispose();
  assert.equal(f.state.calls, 1);
  const services = f.bridge.hostUiServices();
  const query = {
    scope: input.scope,
    candidate: {
      descriptor: f.descriptor,
      packageDigest: f.publication.packageDigest,
    },
    requirement: f.descriptor.requires[0]!,
  };
  assert.equal(services.isAvailable(query), true);
  await f.bridge.close();
  assert.equal(services.isAvailable(query), false);
  await assert.rejects(f.invoke());
});

test("response source mismatch, extra fields and complete UTF8 oversize are rejected", async () => {
  const f = generationReadBridgeFixture();
  for (const output of [
    { ...generationReadResponse(), extra: true },
    {
      generation: {
        ...generationReadResponse().generation!,
        assetId: "foreign",
      },
    },
    {
      generation: {
        ...generationReadResponse().generation!,
        task: {
          ...generationReadResponse().generation!.task,
          operations: Array.from({ length: 16 }, (_, index) => ({
            operationId: `11111111-2222-3333-4444-${String(index).padStart(12, "0")}`,
            sourceRunId: "original-run",
            status: "succeeded" as const,
            operationRevision: 1,
            observedAt: "2026-10-03T00:00:00.000Z",
            images: Array.from({ length: 16 }, (_, resultIndex) => ({
              filename: "中".repeat(120),
              url: `https://comfy.example.test/view?filename=${"x".repeat(150)}`,
              resultIndex,
            })),
          })),
        },
      },
    },
  ]) {
    f.state.output = output;
    await assert.rejects(f.invoke());
  }
});

test("known optional read protocol can coexist with disabled readers, while required/unknown protocols fail closed", () => {
  const f = generationReadBridgeFixture();
  const candidate = {
    descriptor: f.descriptor,
    packageDigest: f.publication.packageDigest,
  };
  assertUiOnlyServiceDeclarations(f.descriptor);
  assertPluginUiHostServiceAvailability({
    scope: f.context().scope,
    candidate,
  });
  const required = parsePluginPackageDescriptor({
    ...f.descriptor,
    requires: [{ ...f.descriptor.requires[0]!, optional: false }],
  });
  assert.throws(
    () =>
      assertPluginUiHostServiceAvailability({
        scope: f.context().scope,
        candidate: { ...candidate, descriptor: required },
      }),
    /plugin_dependency_unavailable/u,
  );
  const unknown = parsePluginPackageDescriptor({
    ...f.descriptor,
    requires: [{ ...f.descriptor.requires[0]!, apiVersion: "2" }],
  });
  assert.throws(
    () => assertUiOnlyServiceDeclarations(unknown),
    /plugin_ui_only_services_unsupported/u,
  );
});

test("read availability wrapper preserves independently assembled paid marker and captured ordinary service receiver", () => {
  const f = generationReadBridgeFixture();
  const base = registerProjectGenerationHostAvailability({
    isAvailable: () => true,
  });
  const services = f.bridge.hostUiServices(base);
  assert.equal(hasProjectGenerationHostAvailability(services), true);
  assert.equal(
    services.isAvailable({
      scope: f.context().scope,
      candidate: {
        descriptor: f.descriptor,
        packageDigest: f.publication.packageDigest,
      },
      requirement: {
        service: "crewon.creative-projects",
        apiVersion: "1",
        optional: false,
      },
    }),
    true,
  );
  assert.throws(
    () =>
      new PluginProjectGenerationReadActionBridge({
        publications: [f.publication],
        reads: Object.defineProperty({}, "getConceptGeneration", {
          get() {
            throw new Error("must_not_evaluate");
          },
        }) as never,
      }),
    /read_adapter_invalid/u,
  );
});
