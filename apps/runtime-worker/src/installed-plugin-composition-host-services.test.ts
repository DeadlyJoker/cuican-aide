import assert from "node:assert/strict";
import test from "node:test";
import { captureInstalledPluginCompositionExecution } from "./plugins/installed-plugin-composition-runtime-owner.ts";

const metadata = Object.freeze({
  service: "crewon.tasks",
  apiVersion: "1",
  implementationId: "crewon.desktop-task-core-binding.v1",
  implementationRevision: 1,
});

test("deployment captures paired actual ports without rebinding their source owner or adding grants", () => {
  const identity = Object.freeze({
    pluginId: "test.consumer",
    version: "1.0.0",
    packageDigest: "sha256:" + "a".repeat(64),
  });
  const lifecycle = { onDispose() {} };
  const owner = {
    service: metadata.service,
    apiVersion: metadata.apiVersion,
    value: Object.freeze({}),
    bindForPlugin(actual: unknown, lifetime: unknown) {
      assert.equal(this, owner);
      assert.equal(actual, identity);
      assert.equal(lifetime, lifecycle);
      return bound;
    },
  };
  const bound = Object.freeze({
    createTask() {
      throw new Error("no_host_issued_reference");
    },
  });
  const input = [{ metadata, implementation: owner }];
  const captured = captureInstalledPluginCompositionExecution({
    hostServiceMetadata: [metadata],
    hostServices: input,
  });
  input.length = 0;
  assert.ok(Object.isFrozen(captured.hostServices));
  assert.equal(captured.hostServices?.length, 1);
  assert.equal(
    captured.hostServices![0]!.implementation.bindForPlugin!(
      identity,
      lifecycle,
    ),
    bound,
  );
  assert.throws(() => bound.createTask(), /no_host_issued_reference/);
});

test("an implementation must match its explicitly approved deployment identity", () => {
  const implementation = {
    service: metadata.service,
    apiVersion: metadata.apiVersion,
    value: Object.freeze({}),
  };
  for (const declarations of [
    [],
    [{ ...metadata, implementationId: "other.owner" }],
    [{ ...metadata, implementationRevision: 2 }],
  ]) {
    assert.throws(
      () =>
        captureInstalledPluginCompositionExecution({
          hostServiceMetadata: declarations,
          hostServices: [{ metadata, implementation }],
        }),
      /installed_plugin_composition_host_service_identity_conflict/,
    );
  }
  assert.throws(() =>
    captureInstalledPluginCompositionExecution({
      hostServiceMetadata: [metadata],
      hostServices: [
        { metadata, implementation },
        { metadata, implementation },
      ],
    }),
  );
});

test("service declarations cannot substitute for executable ports, and accessors are never evaluated", () => {
  let reads = 0;
  const input = Object.defineProperty(
    { hostServiceMetadata: [metadata] },
    "hostServices",
    {
      enumerable: true,
      get() {
        reads++;
        return [];
      },
    },
  );
  assert.throws(
    () => captureInstalledPluginCompositionExecution(input),
    /installed_plugin_composition_configuration_invalid/,
  );
  assert.equal(reads, 0);
  assert.throws(() =>
    captureInstalledPluginCompositionExecution({
      hostServiceMetadata: [metadata],
      hostServices: [metadata] as never,
    }),
  );
  assert.throws(
    () =>
      captureInstalledPluginCompositionExecution({
        hostServiceMetadata: [metadata],
        hostServices: [],
        owner: "self-claimed",
      } as never),
    /installed_plugin_composition_configuration_invalid/,
  );
});
