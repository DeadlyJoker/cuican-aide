import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  assertPluginUiHostServiceAvailability,
  assertUiOnlyServiceDeclarations,
  capturePluginUiHostServiceAvailability,
} from "./plugin-ui-host-service-availability.ts";
import { projectGenerationBridgeFixture } from "./plugin-project-generation-action-bridge.test-support.ts";
import {
  PluginProjectGenerationActionBridge,
  type PluginProjectGenerationDispatchPort,
} from "./plugin-project-generation-action-bridge.ts";

function candidate(f = projectGenerationBridgeFixture(), optional = false) {
  const context = f.app.detachedContext();
  return {
    f,
    candidate: {
      descriptor: parsePluginPackageDescriptor({
        ...context.lease.descriptor,
        entrypoints: {
          node: null,
          ui: context.lease.descriptor.entrypoints.ui,
        },
        files: context.lease.descriptor.files.filter(
          (file) => file.path === "ui.mjs",
        ),
        requires: [
          { service: "crewon.project-generations", apiVersion: "1", optional },
        ],
      }),
      packageDigest: context.package.packageDigest,
    },
  };
}

test("generation stays unavailable to arbitrary metadata ports and absent assembly", () => {
  const { candidate: actual } = candidate();
  for (const port of [
    undefined,
    { isAvailable: () => true },
    capturePluginUiHostServiceAvailability({ isAvailable: () => true }),
  ])
    assert.throws(
      () => assertUiOnlyServiceDeclarations(actual.descriptor, port),
      /plugin_ui_only_services_unsupported/u,
    );
});

test("assembled generation availability survives capture, checks exact source and tracks actual closed state", () => {
  const { f, candidate: actual } = candidate();
  const services = capturePluginUiHostServiceAvailability(
    f.bridge.hostUiServices(),
  );
  const input = {
    scope: f.app.detachedContext().scope,
    candidate: actual,
    hostUiServices: services,
  };
  assertPluginUiHostServiceAvailability(input);
  assert.equal(f.state.availabilityCalls, 1);
  for (const mismatched of [
    { ...actual, packageDigest: `sha256:${"d".repeat(64)}` },
    {
      ...actual,
      descriptor: parsePluginPackageDescriptor({
        ...actual.descriptor,
        pluginId: "example.other",
      }),
    },
  ])
    assert.throws(
      () =>
        assertPluginUiHostServiceAvailability({
          ...input,
          candidate: mismatched,
        }),
      /plugin_dependency_unavailable/u,
    );
  f.state.available = false;
  assert.throws(
    () => assertPluginUiHostServiceAvailability(input),
    /plugin_dependency_unavailable/u,
  );
  f.state.available = true;
  f.bridge.close();
  assert.throws(
    () => assertPluginUiHostServiceAvailability(input),
    /plugin_dependency_unavailable/u,
  );
});

test("optional known generation permits installation but never calls readiness or grants invocation", () => {
  const { f, candidate: actual } = candidate(undefined, true);
  f.state.available = false;
  assertPluginUiHostServiceAvailability({
    scope: f.app.detachedContext().scope,
    candidate: actual,
    hostUiServices: f.bridge.hostUiServices(),
  });
  assert.equal(f.state.availabilityCalls, 0);
});

test("metadata composition retains its own availability and unknown services/versions remain rejected", () => {
  const { f, candidate: actual } = candidate();
  let metadataCalls = 0;
  const services = f.bridge.hostUiServices({
    isAvailable: ({ requirement }) => {
      metadataCalls++;
      return requirement.service === "crewon.creative-projects";
    },
  });
  const scope = f.app.detachedContext().scope;
  const descriptor = parsePluginPackageDescriptor({
    ...actual.descriptor,
    requires: [
      { service: "crewon.creative-projects", apiVersion: "1", optional: false },
      ...actual.descriptor.requires,
    ],
  });
  assertPluginUiHostServiceAvailability({
    scope,
    candidate: { ...actual, descriptor },
    hostUiServices: services,
  });
  assert.equal(metadataCalls, 1);
  for (const requirement of [
    { service: "crewon.project-generations", apiVersion: "2", optional: true },
    { service: "crewon.tasks", apiVersion: "1", optional: true },
  ])
    assert.throws(
      () =>
        assertUiOnlyServiceDeclarations(
          parsePluginPackageDescriptor({
            ...actual.descriptor,
            requires: [requirement],
          }),
          services,
        ),
      /plugin_ui_only_services_unsupported/u,
    );
});

test("a misconfigured async readiness callback fails synchronously and observes its late rejection", async () => {
  const { f, candidate: actual } = candidate();
  const generation = {
    generate: f.generation.generate,
    isAvailable: () => Promise.reject(new Error("async readiness unavailable")),
  } as unknown as PluginProjectGenerationDispatchPort;
  const bridge = new PluginProjectGenerationActionBridge({
    publications: [f.app.publication],
    generation,
    committedTasks: f.app.authority,
  });
  assert.throws(
    () =>
      assertPluginUiHostServiceAvailability({
        scope: f.app.detachedContext().scope,
        candidate: actual,
        hostUiServices: bridge.hostUiServices(),
      }),
    /plugin_dependency_unavailable/u,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
});
