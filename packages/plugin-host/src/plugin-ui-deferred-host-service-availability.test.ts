import assert from "node:assert/strict";
import test from "node:test";
import type { PluginUiActionContext } from "@crewon/application";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import * as publicHost from "./index.ts";
import { createDeferredPluginUiHostServiceAvailability } from "./plugin-ui-deferred-host-service-availability.ts";
import {
  appendPluginUiRecoveryServiceAvailability,
  appendProjectGenerationSelectionUiServiceAvailability,
  assertPluginUiHostServiceAvailability,
  assertUiOnlyServiceDeclarations,
  capturePluginUiHostServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "./plugin-ui-host-service-availability.ts";
import { projectGenerationBridgeFixture } from "./plugin-project-generation-action-bridge.test-support.ts";
import { generationContextBridgeFixture } from "./plugin-project-generation-context-action-bridge.test-support.ts";
import { projectGenerationQueryBridgeFixture } from "./plugin-project-generation-query-action-bridge.test-support.ts";
import { PluginProjectGenerationReadActionBridge } from "./plugin-project-generation-read-action-bridge.ts";

const generation = "crewon.project-generations";
const contexts = "crewon.project-generation-contexts";
const queries = "crewon.project-generation-queries";
const metadata = "crewon.creative-projects";
const invalidBinding = /plugin_ui_deferred_host_service_availability_invalid/u;
const unsupported = /plugin_ui_only_services_unsupported/u;
const unavailable = /plugin_dependency_unavailable/u;
function request(context: PluginUiActionContext, service = generation) {
  const descriptor = parsePluginPackageDescriptor({
    ...context.lease.descriptor,
    entrypoints: { node: null, ui: context.lease.descriptor.entrypoints.ui },
    files: context.lease.descriptor.files.filter(
      (file) => file.path === "ui.mjs",
    ),
    requires: [{ service, apiVersion: "1", optional: false }],
  });
  return {
    scope: context.scope,
    candidate: { descriptor, packageDigest: context.package.packageDigest },
    requirement: descriptor.requires[0]!,
  };
}
function ready(
  port: PluginUiHostServiceAvailabilityPort,
  input: ReturnType<typeof request>,
) {
  assertPluginUiHostServiceAvailability({ ...input, hostUiServices: port });
}

// These reuse real Host bridge classes over explicitly named memory Application fixtures.
// Availability makes no invocation, SQLite, provider, wallet or production-execution claim.
test("Host availability captured before assembly stays unavailable until the real generation bridge is bound", async (t) => {
  const f = projectGenerationBridgeFixture();
  t.after(() => f.bridge.close());
  const deferred = createDeferredPluginUiHostServiceAvailability();
  const captured = capturePluginUiHostServiceAvailability(deferred.port)!;
  const recaptured = capturePluginUiHostServiceAvailability(captured)!;
  const input = request(f.app.detachedContext());
  assert.ok(Object.isFrozen(deferred));
  assert.ok(Object.isFrozen(deferred.port));
  assert.equal(recaptured.isAvailable(input), false);
  assert.throws(() => ready(recaptured, input), unsupported);
  assert.throws(
    () => ready(recaptured, request(f.app.detachedContext(), metadata)),
    unavailable,
  );
  assert.equal(f.state.availabilityCalls, 0);

  deferred.bind(f.bridge.hostUiServices());
  ready(captured, input);
  ready(recaptured, input);
  const wrong = {
    ...input,
    candidate: {
      ...input.candidate,
      packageDigest: `sha256:${"f".repeat(64)}`,
    },
  };
  assert.throws(() => ready(recaptured, wrong), unavailable);
  f.state.available = false;
  assert.throws(() => ready(recaptured, input), unavailable);
  f.state.available = true;
  ready(recaptured, input);
  await f.bridge.close();
  assert.throws(() => ready(recaptured, input), unavailable);
  assert.equal(f.state.generationCalls, 0);
  assert.equal(f.state.currentCalls, 0);
});

test("deferred binding preserves three independently assembled brands through real read and selection/recovery composition", async (t) => {
  const g = projectGenerationBridgeFixture();
  const c = generationContextBridgeFixture();
  const q = await projectGenerationQueryBridgeFixture();
  let metadataCalls = 0,
    selectionCalls = 0,
    recoveryCalls = 0,
    reads = 0;
  const reader = new PluginProjectGenerationReadActionBridge({
    publications: [
      {
        pluginId: q.app.sourcePin.pluginId,
        packageDigest: q.app.sourcePin.packageDigest,
        contributionId: q.app.sourcePin.contributionId,
      },
    ],
    reads: {
      getConceptGeneration: async () => {
        reads++;
        throw new Error("availability-must-not-read-history");
      },
      isAvailable: () => true,
    },
  });
  t.after(async () => {
    await Promise.all([
      g.bridge.close(),
      c.bridge.close(),
      q.bridge.close(),
      reader.close(),
    ]);
  });
  const actual = appendPluginUiRecoveryServiceAvailability({
    recovery: {
      isAvailable: () => {
        recoveryCalls++;
        return true;
      },
    },
    fallback: appendProjectGenerationSelectionUiServiceAvailability({
      selection: {
        isAvailable: () => {
          selectionCalls++;
          return true;
        },
      },
      fallback: reader.hostUiServices(
        q.bridge.hostUiServices(
          c.bridge.hostUiServices(
            g.bridge.hostUiServices({
              isAvailable: (input) => {
                metadataCalls++;
                return (
                  input.requirement.service === metadata &&
                  input.requirement.apiVersion === "1"
                );
              },
            }),
          ),
        ),
      ),
    }),
  });
  const deferred = createDeferredPluginUiHostServiceAvailability();
  const before = capturePluginUiHostServiceAvailability(deferred.port)!;
  deferred.bind(actual);
  for (const input of [
    request(g.app.detachedContext()),
    request(c.context(), contexts),
    request(q.context, queries),
    request(q.context, "crewon.project-generation-reads"),
    request(q.context, "crewon.project-generation-selections"),
    request(q.context, "crewon.plugin-ui-recovery"),
    request(q.context, metadata),
  ])
    ready(before, input);
  assert.equal(metadataCalls, 1);
  assert.equal(selectionCalls, 1);
  assert.equal(recoveryCalls, 1);
  assert.equal(reads, 0);
  assert.equal(g.state.generationCalls, 0);
  assert.equal(c.state.calls, 0);
  assert.equal(q.state.calls, 0);

  deferred.close();
  deferred.close();
  for (const input of [
    request(g.app.detachedContext()),
    request(c.context(), contexts),
    request(q.context, queries),
  ]) {
    assert.equal(before.isAvailable(input), false);
    assert.throws(() => ready(before, input), unsupported);
  }
  assert.throws(() => deferred.bind(actual), invalidBinding);
});

test("generic boolean callbacks and copied or inherited actual ports never acquire required generation/context/query branding", async (t) => {
  const g = projectGenerationBridgeFixture();
  const c = generationContextBridgeFixture();
  const q = await projectGenerationQueryBridgeFixture();
  t.after(async () => {
    await Promise.all([g.bridge.close(), c.bridge.close(), q.bridge.close()]);
  });
  for (const [actual, input] of [
    [g.bridge.hostUiServices(), request(g.app.detachedContext())],
    [c.bridge.hostUiServices(), request(c.context(), contexts)],
    [q.bridge.hostUiServices(), request(q.context, queries)],
  ] as const) {
    for (const forged of [
      { isAvailable: () => true },
      { ...actual },
      Object.create(actual),
    ]) {
      const deferred = createDeferredPluginUiHostServiceAvailability();
      const before = capturePluginUiHostServiceAvailability(deferred.port)!;
      deferred.bind(forged);
      assert.throws(() => ready(before, input), unsupported);
      deferred.close();
    }
  }
  assert.equal(g.state.generationCalls, 0);
  assert.equal(c.state.calls, 0);
  assert.equal(q.state.calls, 0);
});

test("binding captures one original receiver and rejects getters, repeated binding and binding after permanent withdrawal", () => {
  const f = projectGenerationBridgeFixture();
  const input = request(f.app.detachedContext(), metadata);
  const deferred = createDeferredPluginUiHostServiceAvailability();
  const before = capturePluginUiHostServiceAvailability(deferred.port)!;
  let getters = 0,
    calls = 0;
  const getter = Object.defineProperty({}, "isAvailable", {
    get() {
      getters++;
      return () => true;
    },
  }) as PluginUiHostServiceAvailabilityPort;
  assert.throws(
    () => deferred.bind(getter),
    /plugin_ui_host_service_availability_invalid/u,
  );
  assert.equal(getters, 0);
  assert.equal(before.isAvailable(input), false);
  const actual = {
    flag: true,
    isAvailable() {
      calls++;
      return this.flag;
    },
  };
  deferred.bind(actual);
  actual.isAvailable = () => false;
  ready(before, input);
  assert.equal(calls, 1);
  assert.throws(
    () => deferred.bind({ isAvailable: () => false }),
    invalidBinding,
  );
  ready(before, input);
  actual.flag = false;
  assert.throws(() => ready(before, input), unavailable);
  deferred.close();
  assert.equal(before.isAvailable(input), false);
  assert.throws(() => deferred.bind(actual), invalidBinding);
  const neverBound = createDeferredPluginUiHostServiceAvailability();
  neverBound.close();
  assert.throws(() => neverBound.bind(actual), invalidBinding);
  f.bridge.close();
});

test("self-capture, mutually deferred bindings and overlong chains cannot recurse or mint protocol branding", async (t) => {
  const f = projectGenerationBridgeFixture();
  t.after(() => f.bridge.close());
  const input = request(f.app.detachedContext());
  const self = createDeferredPluginUiHostServiceAvailability();
  assert.throws(() => self.bind(self.port), invalidBinding);
  assert.throws(
    () => self.bind(capturePluginUiHostServiceAvailability(self.port)!),
    invalidBinding,
  );
  self.bind(f.bridge.hostUiServices());
  ready(self.port, input);
  const a = createDeferredPluginUiHostServiceAvailability();
  const b = createDeferredPluginUiHostServiceAvailability();
  a.bind(b.port);
  b.bind(a.port);
  for (const port of [
    a.port,
    b.port,
    capturePluginUiHostServiceAvailability(a.port)!,
  ]) {
    assert.equal(port.isAvailable(input), false);
    assert.throws(() => ready(port, input), unsupported);
  }
  const chain = Array.from({ length: 96 }, () =>
    createDeferredPluginUiHostServiceAvailability(),
  );
  chain[95]!.bind(f.bridge.hostUiServices());
  for (let index = 94; index >= 0; index--)
    chain[index]!.bind(chain[index + 1]!.port);
  const previous = f.state.availabilityCalls;
  assert.equal(chain[0]!.port.isAvailable(input), false);
  assert.equal(f.state.availabilityCalls, previous);
  assert.throws(() => ready(chain[0]!.port, input), unsupported);
  ready(chain[90]!.port, input);
});

test("unknown service versions remain rejected and asynchronous answers never satisfy a synchronous publication fence", async (t) => {
  const f = projectGenerationBridgeFixture();
  t.after(() => f.bridge.close());
  const deferred = createDeferredPluginUiHostServiceAvailability();
  const before = capturePluginUiHostServiceAvailability(deferred.port)!;
  deferred.bind(f.bridge.hostUiServices());
  const input = request(f.app.detachedContext());
  for (const requirement of [
    { service: generation, apiVersion: "2", optional: true },
    {
      service: "example.project-generations",
      apiVersion: "1",
      optional: false,
    },
  ]) {
    const descriptor = parsePluginPackageDescriptor({
      ...input.candidate.descriptor,
      requires: [requirement],
    });
    assert.throws(
      () => assertUiOnlyServiceDeclarations(descriptor, before),
      unsupported,
    );
  }
  const asyncOnly = createDeferredPluginUiHostServiceAvailability();
  asyncOnly.bind({
    isAvailable: () =>
      Promise.reject(new Error("named-async-availability-refusal")),
  } as unknown as PluginUiHostServiceAvailabilityPort);
  const metadataInput = request(f.app.detachedContext(), metadata);
  assert.equal(asyncOnly.port.isAvailable(metadataInput), false);
  assert.throws(() => ready(asyncOnly.port, metadataInput), unavailable);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const closesWhileAnswering = createDeferredPluginUiHostServiceAvailability();
  closesWhileAnswering.bind({
    isAvailable: () => {
      closesWhileAnswering.close();
      return true;
    },
  });
  assert.equal(closesWhileAnswering.port.isAvailable(metadataInput), false);
});

test("the public Host API exports composition without exposing private availability registration or brand transfer", () => {
  assert.equal(
    publicHost.createDeferredPluginUiHostServiceAvailability,
    createDeferredPluginUiHostServiceAvailability,
  );
  for (const name of [
    "registerProjectGenerationHostAvailability",
    "registerProjectGenerationContextHostAvailability",
    "registerProjectGenerationQueryHostAvailability",
    "hasDeferredPluginUiHostServiceAvailabilityBrand",
    "preserveDeferredPluginUiHostServiceAvailability",
  ])
    assert.equal(Object.hasOwn(publicHost, name), false);
});
