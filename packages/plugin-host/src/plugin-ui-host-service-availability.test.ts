import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  assertPluginUiHostServiceAvailability,
  assertUiOnlyServiceDeclarations,
  capturePluginUiHostServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "./plugin-ui-host-service-availability.ts";
import { scope } from "./plugin-installation-local-host.test-support.ts";

const requirement = Object.freeze({
  service: "crewon.creative-projects",
  apiVersion: "1",
  optional: false,
});
const packageDigest = `sha256:${"a".repeat(64)}`;
function descriptor(
  input: { requires?: unknown; provides?: unknown; node?: boolean } = {},
) {
  return parsePluginPackageDescriptor({
    schemaVersion: "crewon.plugin-package.v1",
    hostApi: "crewon.plugin-host.v1",
    pluginId: "example.story",
    version: "1.0.0",
    title: "Story",
    description: "Metadata only",
    publisherId: "example.publisher",
    entrypoints: {
      node: input.node ? "entry.mjs" : null,
      ui: { path: "ui.mjs", mode: "trustedModule" },
    },
    businessManifestPath: null,
    requires: input.requires ?? [],
    provides: input.provides ?? [],
    contributions: [
      { id: "story", kind: "module", slot: "main.content", title: "Story" },
    ],
    files: [
      { path: "ui.mjs", byteLength: 1, sha256: "a".repeat(64) },
      ...(input.node
        ? [{ path: "entry.mjs", byteLength: 1, sha256: "b".repeat(64) }]
        : []),
    ],
  });
}
function candidate(input: Parameters<typeof descriptor>[0] = {}) {
  return Object.freeze({ descriptor: descriptor(input), packageDigest });
}
const rejectsUnavailable = (work: () => unknown) =>
  assert.throws(work, { code: "plugin_dependency_unavailable" });

test("legacy UI-only packages stay valid; absent Host port preserves requires rejection", () => {
  assertUiOnlyServiceDeclarations(descriptor());
  assertPluginUiHostServiceAvailability({ scope, candidate: candidate() });
  for (const optional of [false, true])
    assert.throws(
      () =>
        assertUiOnlyServiceDeclarations(
          descriptor({ requires: [{ ...requirement, optional }] }),
        ),
      { code: "plugin_ui_only_services_unsupported" },
    );
});
test("an explicit port recognizes only metadata v1; unknown services, versions and all provides remain rejected", () => {
  const hostUiServices = capturePluginUiHostServiceAvailability({
    isAvailable: () => true,
  });
  assertUiOnlyServiceDeclarations(
    descriptor({ requires: [requirement] }),
    hostUiServices,
  );
  for (const requires of [
    [{ ...requirement, service: "crewon.tasks" }],
    [{ ...requirement, apiVersion: "2" }],
    [
      {
        ...requirement,
        service: "example.crewon.creative-projects",
        optional: true,
      },
    ],
  ])
    assert.throws(
      () =>
        assertUiOnlyServiceDeclarations(
          descriptor({ requires }),
          hostUiServices,
        ),
      { code: "plugin_ui_only_services_unsupported" },
    );
  assert.throws(
    () =>
      assertUiOnlyServiceDeclarations(
        descriptor({
          provides: [{ service: "example.story", apiVersion: "1" }],
        }),
        hostUiServices,
      ),
    { code: "plugin_ui_only_services_unsupported" },
  );
});
test("availability receives actual verified candidate, requirement and detached exact profile scope", () => {
  const actual = candidate({ requires: [requirement] });
  let calls = 0;
  const hostUiServices = capturePluginUiHostServiceAvailability({
    isAvailable(input) {
      calls++;
      assert.deepEqual(input.scope, scope);
      assert.equal(input.candidate.descriptor, actual.descriptor);
      assert.equal(input.candidate.packageDigest, packageDigest);
      assert.equal(input.requirement, actual.descriptor.requires[0]);
      assert.ok(Object.isFrozen(input));
      assert.ok(Object.isFrozen(input.scope));
      assert.ok(Object.isFrozen(input.candidate));
      return true;
    },
  });
  assertPluginUiHostServiceAvailability({
    scope,
    candidate: actual,
    hostUiServices,
  });
  assert.equal(calls, 1);
});
test("captured callbacks remain bound and reject closed state rather than replacement dispatch", () => {
  const port = {
    open: true,
    isAvailable() {
      assert.equal(this, port);
      return this.open;
    },
  };
  const captured = capturePluginUiHostServiceAvailability(port);
  port.isAvailable = () => false;
  const input = {
    scope,
    candidate: candidate({ requires: [requirement] }),
    hostUiServices: captured,
  };
  assertPluginUiHostServiceAvailability(input);
  port.open = false;
  rejectsUnavailable(() => assertPluginUiHostServiceAvailability(input));
});
test("false, truthy values, async answers and exceptions all fail closed", () => {
  for (const isAvailable of [
    () => false,
    () => "available",
    () => 1,
    () => Promise.resolve(true),
    () => {
      throw new Error("closed");
    },
  ]) {
    const hostUiServices = capturePluginUiHostServiceAvailability({
      isAvailable,
    } as unknown as PluginUiHostServiceAvailabilityPort);
    rejectsUnavailable(() =>
      assertPluginUiHostServiceAvailability({
        scope,
        candidate: candidate({ requires: [requirement] }),
        hostUiServices,
      }),
    );
  }
});
test("known optional metadata does not call availability and never becomes a Node requirement", () => {
  let calls = 0;
  const hostUiServices = capturePluginUiHostServiceAvailability({
    isAvailable() {
      calls++;
      return false;
    },
  });
  assertPluginUiHostServiceAvailability({
    scope,
    candidate: candidate({ requires: [{ ...requirement, optional: true }] }),
    hostUiServices,
  });
  assertPluginUiHostServiceAvailability({
    scope,
    candidate: candidate({ node: true, requires: [requirement] }),
    hostUiServices,
  });
  assert.equal(calls, 0);
});
test("rejected native Promises and thenables fail synchronously, observe late rejection and never read then getters", async () => {
  let getters = 0;
  const thenable = {
    get then() {
      getters++;
      throw new Error("must not read then");
    },
  };
  const values = [
    Promise.reject(new Error("native async availability rejected")),
    thenable,
  ];
  for (const value of values) {
    const hostUiServices = capturePluginUiHostServiceAvailability({
      isAvailable: () => value,
    } as unknown as PluginUiHostServiceAvailabilityPort);
    rejectsUnavailable(() =>
      assertPluginUiHostServiceAvailability({
        scope,
        candidate: candidate({ requires: [requirement] }),
        hostUiServices,
      }),
    );
  }
  const raw = {
    isAvailable: () =>
      Promise.reject(new Error("raw async availability rejected")),
  } as unknown as PluginUiHostServiceAvailabilityPort;
  rejectsUnavailable(() =>
    assertPluginUiHostServiceAvailability({
      scope,
      candidate: candidate({ requires: [requirement] }),
      hostUiServices: raw,
    }),
  );
  assert.equal(getters, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
});
test("port capture rejects missing methods and accessors without executing them", () => {
  let calls = 0;
  const getter = {
    get isAvailable() {
      calls++;
      return () => true;
    },
  };
  for (const port of [null, {}, { isAvailable: true }, getter])
    assert.throws(
      () =>
        capturePluginUiHostServiceAvailability(
          port as PluginUiHostServiceAvailabilityPort,
        ),
      { code: "plugin_ui_host_service_availability_invalid" },
    );
  assert.equal(calls, 0);
});
