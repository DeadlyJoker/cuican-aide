import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePluginPackageDescriptor,
  parsePluginUiLease,
} from "@crewon/contracts/plugins";
import {
  PluginProjectGenerationContextActionBridge,
  isPluginProjectGenerationContextActionBridge,
  type PluginProjectGenerationContextDispatchPort,
} from "./plugin-project-generation-context-action-bridge.ts";
import { generationContextBridgeFixture } from "./plugin-project-generation-context-action-bridge.test-support.ts";
import { generationReadBridgeFixture } from "./plugin-project-generation-read-action-bridge.test-support.ts";
import {
  assertPluginUiHostServiceAvailability,
  assertUiOnlyServiceDeclarations,
  capturePluginUiHostServiceAvailability,
} from "./plugin-ui-host-service-availability.ts";
import {
  hasProjectGenerationHostAvailability,
  registerProjectGenerationHostAvailability,
} from "./plugin-project-generation-host-availability.ts";
import { hasProjectGenerationContextHostAvailability } from "./plugin-project-generation-context-host-availability.ts";

test("contexts read returns detached readiness under the actual source read action and publication", async () => {
  const f = generationContextBridgeFixture();
  const original = f.context();
  const output = await f.invoke(original);
  assert.deepEqual(output, f.state.output);
  assert.notEqual(output, f.state.output);
  assert.equal(
    f.state.last!.sourcePin.action,
    "crewon.project-generation-contexts.v1.getReadiness",
  );
  assert.deepEqual(f.state.last!.reference, f.reference);
  assert.deepEqual(f.state.last!.publication, f.publication);
  assert.equal(f.state.last!.context, original);
  assert.equal(
    f.state.last!.context.package.pluginId,
    f.publication.source.pluginId,
  );
  assert.equal(f.state.currentCalls, 2);
  assert.ok(isPluginProjectGenerationContextActionBridge(f.bridge));
  assert.equal(
    isPluginProjectGenerationContextActionBridge({ ...f.bridge }),
    false,
  );
  for (const reasonCode of [
    "project_generation_input_unavailable",
    "project_generation_configuration_unavailable",
    "project_generation_runtime_unavailable",
  ] as const) {
    f.state.output = {
      reference: f.reference,
      readiness: { outcome: "unavailable", reasonCode },
    };
    assert.deepEqual(await f.invoke(), f.state.output);
  }
});

test("reserved contexts family rejects unknown actions and versions without ordinary task fallback", async () => {
  const f = generationContextBridgeFixture();
  for (const action of [
    "crewon.project-generation-contexts",
    "crewon.project-generation-contexts.v2.getReadiness",
    "crewon.project-generation-contexts.v1.generateConcept",
  ])
    await assert.rejects(
      f.invoke({ ...f.context(), action }),
      /context_action_invalid/u,
    );
  assert.deepEqual(
    await f.actions.invoke({ ...f.context(), action: "ordinary.read" }),
    { ordinary: true },
  );
  assert.equal(f.state.fallbacks, 1);
  assert.equal(f.state.calls, 0);
});

test("actual invocation membership precedes all nested input and source getters", async () => {
  const f = generationContextBridgeFixture();
  let evaluated = 0;
  const fake = f.context();
  Object.defineProperty(fake, "input", {
    enumerable: true,
    get() {
      evaluated++;
      throw new Error("must_not_evaluate");
    },
  });
  await assert.rejects(
    f.actions.invoke(fake),
    /plugin_ui_invocation_unavailable/u,
  );
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
  const nested = f.context();
  Object.defineProperty(
    (nested.input as { reference: unknown }).reference,
    "assetRevision",
    {
      enumerable: true,
      get() {
        evaluated++;
        throw new Error("must_not_evaluate");
      },
    },
  );
  await assert.rejects(f.invoke(nested));
  assert.equal(evaluated, 0);
  assert.equal(f.state.calls, 0);
});

test("source identity and contexts declaration must match exact enabled module publication", async () => {
  const f = generationContextBridgeFixture();
  for (const input of [
    {
      ...f.context(),
      package: {
        ...f.context().package,
        packageDigest: `sha256:${"c".repeat(64)}`,
      },
    },
    {
      ...f.context(),
      selection: {
        ...f.context().selection,
        state: "disabled" as const,
        selectedPackageDigest: null,
      },
    },
    { ...f.context(), actor: { ...f.context().actor, tenantId: "foreign" } },
    {
      ...f.context(),
      lease: {
        ...f.context().lease,
        descriptor: parsePluginPackageDescriptor({
          ...f.descriptor,
          requires: [
            {
              service: "crewon.project-generations",
              apiVersion: "1",
              optional: false,
            },
          ],
        }),
      },
    },
    {
      ...f.context(),
      lease: parsePluginUiLease({
        ...f.context().lease,
        contributionId: "other",
        descriptor: parsePluginPackageDescriptor({
          ...f.descriptor,
          contributions: [
            ...f.descriptor.contributions,
            {
              id: "other",
              kind: "module",
              slot: "main.content",
              title: "Other",
            },
          ],
        }),
      }),
    },
    {
      ...f.context(),
      lease: {
        ...f.context().lease,
        descriptor: parsePluginPackageDescriptor({
          ...f.descriptor,
          contributions: [
            {
              id: "workbench",
              kind: "settings",
              slot: "settings.section",
              title: "Settings",
            },
          ],
        }),
      },
    },
  ])
    await assert.rejects(f.invoke(input));
  assert.equal(f.state.calls, 0);
});

test("trusted receiver and publications are captured once before awaited readiness", async () => {
  const f = generationContextBridgeFixture();
  const held = f.deferred(),
    entered = f.deferred();
  f.state.beforeRead = async () => {
    entered.resolve();
    await held.promise;
  };
  const pending = f.invoke();
  await entered.promise;
  (f.contexts as { getReadiness: unknown }).getReadiness = async () => {
    throw new Error("replaced");
  };
  f.publication.source.packageDigest = `sha256:${"c".repeat(64)}`;
  f.publication.target.action = "other";
  held.resolve();
  assert.deepEqual(await pending, f.state.output);
  f.state.beforeRead = undefined;
  assert.deepEqual(await f.invoke(), f.state.output);
  assert.equal(f.state.last!.publication.target.action, "generate");
});

test("changed reference or authority epoch during authorization cannot reach capability read", async () => {
  for (const mutate of [
    (
      input: ReturnType<
        ReturnType<typeof generationContextBridgeFixture>["context"]
      >,
    ) => {
      (input.input as { reference: { expectedProjectRevision: number } })
        .reference.expectedProjectRevision++;
    },
    (
      input: ReturnType<
        ReturnType<typeof generationContextBridgeFixture>["context"]
      >,
    ) => {
      (input as { authorityEpoch: string }).authorityEpoch = "epoch-b";
    },
  ]) {
    const f = generationContextBridgeFixture(),
      held = f.deferred();
    f.state.beforeCurrent = () => held.promise;
    const input = f.context(),
      pending = f.invoke(input);
    mutate(input);
    held.resolve();
    await assert.rejects(pending, /context_changed/u);
    assert.equal(f.state.calls, 0);
  }
});

for (const withdrawal of [
  "close",
  "expiry",
  "revocation",
  "dispose",
  "contextMutation",
] as const)
  test(`readiness rejects late JSON after ${withdrawal}, with no task acknowledgement bypass`, async () => {
    const f = generationContextBridgeFixture(),
      held = f.deferred(),
      entered = f.deferred();
    f.state.beforeRead = async () => {
      entered.resolve();
      await held.promise;
    };
    const input = f.context(),
      dispose = f.register(input);
    const pending = f.actions.invoke(input);
    await entered.promise;
    let closing: Promise<void> | undefined;
    if (withdrawal === "close") closing = f.bridge.close();
    else if (withdrawal === "expiry") f.state.open = false;
    else if (withdrawal === "revocation") f.state.allow = false;
    else if (withdrawal === "dispose") dispose();
    else
      (input.input as { reference: { assetRevision: number } }).reference
        .assetRevision++;
    held.resolve();
    await assert.rejects(pending);
    await closing;
    dispose();
  });

test("one actual invocation shares pending readiness and close joins then withdraws assembly", async () => {
  const f = generationContextBridgeFixture(),
    held = f.deferred(),
    entered = f.deferred();
  f.state.beforeRead = async () => {
    entered.resolve();
    await held.promise;
  };
  const input = f.context(),
    dispose = f.register(input);
  const first = f.actions.invoke(input),
    second = f.actions.invoke(input);
  assert.equal(first, second);
  await entered.promise;
  const services = f.bridge.hostUiServices();
  assert.equal(services.isAvailable(f.availability()), true);
  let closed = false;
  const closing = f.bridge.close().then(() => {
    closed = true;
  });
  assert.equal(services.isAvailable(f.availability()), false);
  await Promise.resolve();
  assert.equal(closed, false);
  assert.throws(() => f.actions.invoke(input), /context_unavailable/u);
  held.resolve();
  await assert.rejects(first);
  await closing;
  dispose();
  assert.equal(f.state.calls, 1);
  assert.equal(closed, true);
});

test("readiness pending work is bounded to 128 actual contexts and permits calls after settlement", async () => {
  const f = generationContextBridgeFixture(),
    held = f.deferred();
  f.state.beforeRead = () => held.promise;
  const disposers: (() => void)[] = [],
    pending: Promise<unknown>[] = [];
  for (let index = 0; index < 128; index++) {
    const input = f.context();
    disposers.push(f.register(input));
    pending.push(f.actions.invoke(input));
  }
  const extra = f.context(),
    disposeExtra = f.register(extra);
  assert.throws(() => f.actions.invoke(extra), /plugin_invocation_limit/u);
  held.resolve();
  await Promise.all(pending);
  for (const dispose of disposers) dispose();
  disposeExtra();
  f.state.beforeRead = undefined;
  await f.invoke();
  assert.equal(f.state.calls, 129);
});

test("response exact reference, outcomes and fields reject widening and avoid accessors", async () => {
  const f = generationContextBridgeFixture();
  for (const output of [
    { ...f.state.output, task: {} },
    {
      reference: { ...f.reference, expectedAssetMetadataRevision: 6 },
      readiness: { outcome: "ready" },
    },
    {
      reference: f.reference,
      readiness: {
        outcome: "ready",
        reasonCode: "project_generation_runtime_unavailable",
      },
    },
    {
      reference: f.reference,
      readiness: { outcome: "unavailable", reasonCode: "unknown" },
    },
    {
      reference: f.reference,
      readiness: { outcome: "ready", target: "x".repeat(30 * 1024) },
    },
  ]) {
    f.state.output = output as never;
    await assert.rejects(f.invoke());
  }
  let evaluated = 0;
  f.state.output = Object.defineProperty(
    { reference: f.reference },
    "readiness",
    {
      enumerable: true,
      get() {
        evaluated++;
        throw new Error("must_not_evaluate");
      },
    },
  ) as never;
  await assert.rejects(f.invoke());
  assert.equal(evaluated, 0);
});

test("required contexts stay default off while exact optional declarations do not grant an owner", async () => {
  const f = generationContextBridgeFixture();
  const optional = parsePluginPackageDescriptor({
    ...f.descriptor,
    requires: [{ ...f.descriptor.requires[0]!, optional: true }],
  });
  for (const services of [
    undefined,
    { isAvailable: () => true },
    capturePluginUiHostServiceAvailability({ isAvailable: () => true }),
  ]) {
    assert.throws(
      () => assertUiOnlyServiceDeclarations(f.descriptor, services),
      /plugin_ui_only_services_unsupported/u,
    );
    assertUiOnlyServiceDeclarations(optional, services);
    assertPluginUiHostServiceAvailability({
      scope: f.context().scope,
      candidate: { ...f.availability().candidate, descriptor: optional },
      hostUiServices: services,
    });
    assert.equal(hasProjectGenerationContextHostAvailability(services), false);
  }
  const services = capturePluginUiHostServiceAvailability(
    f.bridge.hostUiServices(),
  );
  assert.ok(hasProjectGenerationContextHostAvailability(services));
  assertPluginUiHostServiceAvailability({
    ...f.availability(),
    hostUiServices: services,
  });
  f.state.available = false;
  assert.throws(
    () =>
      assertPluginUiHostServiceAvailability({
        ...f.availability(),
        hostUiServices: services,
      }),
    /plugin_dependency_unavailable/u,
  );
  const before = f.state.availabilityCalls;
  assertPluginUiHostServiceAvailability({
    scope: f.context().scope,
    candidate: { ...f.availability().candidate, descriptor: optional },
    hostUiServices: services,
  });
  assert.equal(f.state.availabilityCalls, before);
  await f.bridge.close();
  assert.throws(
    () =>
      assertPluginUiHostServiceAvailability({
        ...f.availability(),
        hostUiServices: services,
      }),
    /plugin_dependency_unavailable/u,
  );
});

test("metadata-only assembly enables a version 5 package with optional generation protocols but publishes neither capability", () => {
  const f = generationContextBridgeFixture();
  const descriptor = parsePluginPackageDescriptor({
    ...f.descriptor,
    version: "5.0.0",
    requires: [
      { service: "crewon.creative-projects", apiVersion: "1", optional: false },
      {
        service: "crewon.project-generations",
        apiVersion: "1",
        optional: true,
      },
      {
        service: "crewon.project-generation-contexts",
        apiVersion: "1",
        optional: true,
      },
    ],
  });
  const observed: string[] = [];
  const services = capturePluginUiHostServiceAvailability({
    isAvailable: ({ requirement }) => {
      observed.push(requirement.service);
      return (
        requirement.service === "crewon.creative-projects" &&
        requirement.apiVersion === "1"
      );
    },
  })!;
  const candidate = { ...f.availability().candidate, descriptor };
  assertPluginUiHostServiceAvailability({
    scope: f.context().scope,
    candidate,
    hostUiServices: services,
  });
  assert.deepEqual(observed, ["crewon.creative-projects"]);
  assert.equal(hasProjectGenerationHostAvailability(services), false);
  assert.equal(hasProjectGenerationContextHostAvailability(services), false);
  for (const requirement of descriptor.requires) {
    assert.equal(
      services.isAvailable({
        scope: f.context().scope,
        candidate,
        requirement,
      }),
      requirement.service === "crewon.creative-projects",
    );
  }
  const optional = parsePluginPackageDescriptor({
    ...descriptor,
    requires: descriptor.requires.slice(1),
  });
  assertUiOnlyServiceDeclarations(optional);
  assertPluginUiHostServiceAvailability({
    scope: f.context().scope,
    candidate: { ...candidate, descriptor: optional },
  });
  assert.equal(f.state.calls, 0);
  assert.equal(f.state.availabilityCalls, 0);
});

test("assembly requires exact source and rejects unknown contexts versions and task service declarations", () => {
  const f = generationContextBridgeFixture(),
    services = f.bridge.hostUiServices();
  for (const candidate of [
    {
      ...f.availability().candidate,
      packageDigest: `sha256:${"c".repeat(64)}`,
    },
    {
      ...f.availability().candidate,
      descriptor: parsePluginPackageDescriptor({
        ...f.descriptor,
        pluginId: "example.other",
      }),
    },
  ])
    assert.throws(
      () =>
        assertPluginUiHostServiceAvailability({
          scope: f.context().scope,
          candidate,
          hostUiServices: services,
        }),
      /plugin_dependency_unavailable/u,
    );
  for (const requirement of [
    {
      service: "crewon.project-generation-contexts",
      apiVersion: "2",
      optional: true,
    },
    { service: "crewon.project-generations", apiVersion: "2", optional: true },
    {
      service: "crewon.project-generation-context",
      apiVersion: "1",
      optional: true,
    },
    { service: "crewon.tasks", apiVersion: "1", optional: true },
  ])
    assert.throws(
      () =>
        assertUiOnlyServiceDeclarations(
          parsePluginPackageDescriptor({
            ...f.descriptor,
            requires: [requirement],
          }),
          services,
        ),
      /plugin_ui_only_services_unsupported/u,
    );
});

test("contexts and paid markers survive capture and the production history wrapper", () => {
  const f = generationContextBridgeFixture(),
    read = generationReadBridgeFixture();
  const base = registerProjectGenerationHostAvailability({
    isAvailable: () => true,
  });
  const services = capturePluginUiHostServiceAvailability(
    read.bridge.hostUiServices(f.bridge.hostUiServices(base)),
  )!;
  assert.equal(hasProjectGenerationHostAvailability(services), true);
  assert.equal(hasProjectGenerationContextHostAvailability(services), true);
  assertPluginUiHostServiceAvailability({
    ...f.availability(),
    hostUiServices: services,
  });
  assert.equal(
    services.isAvailable({
      ...f.availability(),
      requirement: {
        service: "crewon.creative-projects",
        apiVersion: "1",
        optional: false,
      },
    }),
    true,
  );
});

test("adapter getters are rejected and asynchronous assembly fails synchronously without unhandled rejection", async () => {
  const f = generationContextBridgeFixture();
  let evaluated = 0;
  assert.throws(
    () =>
      new PluginProjectGenerationContextActionBridge({
        publications: [f.publication],
        contexts: Object.defineProperty({}, "getReadiness", {
          get() {
            evaluated++;
            throw new Error("must_not_evaluate");
          },
        }) as never,
      }),
    /context_adapter_invalid/u,
  );
  assert.equal(evaluated, 0);
  const contexts = {
    getReadiness: f.contexts.getReadiness,
    isAvailable: () => Promise.reject(new Error("async unavailable")),
  } as unknown as PluginProjectGenerationContextDispatchPort;
  const bridge = new PluginProjectGenerationContextActionBridge({
    publications: [f.publication],
    contexts,
  });
  assert.throws(
    () =>
      assertPluginUiHostServiceAvailability({
        ...f.availability(),
        hostUiServices: bridge.hostUiServices(),
      }),
    /plugin_dependency_unavailable/u,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
});
