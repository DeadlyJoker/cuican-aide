import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  assertPluginUiHostServiceAvailability,
  assertUiOnlyServiceDeclarations,
  capturePluginUiHostServiceAvailability,
  appendProjectGenerationSelectionUiServiceAvailability,
  appendPluginUiRecoveryServiceAvailability,
  appendProjectTextUiServiceAvailability,
  appendProjectTextRecoveryUiServiceAvailability,
  appendProjectConversationUiServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "./plugin-ui-host-service-availability.ts";
import { registerProjectGenerationHostAvailability } from "./plugin-project-generation-host-availability.ts";
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

test("conversation availability requires its live independent owner and supplies no task or paid availability", () => {
  const requirement = {
    service: "crewon.project-conversations",
    apiVersion: "1",
    optional: false,
  };
  const actual = candidate({ requires: [requirement] });
  assert.throws(() => assertUiOnlyServiceDeclarations(actual.descriptor), {
    code: "plugin_ui_only_services_unsupported",
  });
  let live = true;
  const port = appendProjectConversationUiServiceAvailability({
    conversations: { isAvailable: () => live },
    fallback: appendProjectTextUiServiceAvailability({
      texts: { isAvailable: () => true },
    }),
  });
  assertPluginUiHostServiceAvailability({
    scope,
    candidate: actual,
    hostUiServices: port,
  });
  live = false;
  rejectsUnavailable(() =>
    assertPluginUiHostServiceAvailability({
      scope,
      candidate: actual,
      hostUiServices: port,
    }),
  );
  assertPluginUiHostServiceAvailability({
    scope,
    candidate: candidate({
      requires: [
        { service: "crewon.project-texts", apiVersion: "1", optional: false },
      ],
    }),
    hostUiServices: port,
  });
  for (const service of ["crewon.tasks", "crewon.project-generations"])
    assert.equal(
      port.isAvailable({
        scope,
        candidate: actual,
        requirement: { ...requirement, service },
      }),
      false,
    );
  assert.equal(
    port.isAvailable({
      scope,
      candidate: actual,
      requirement: { ...requirement, apiVersion: "2" },
    }),
    false,
  );
});

test("text recovery v1 needs independent actual availability and preserves the original text fallback", () => {
  const recovery = {
    service: "crewon.project-text-recovery",
    apiVersion: "1",
    optional: false,
  };
  const actual = candidate({ requires: [recovery] });
  assert.throws(() => assertUiOnlyServiceDeclarations(actual.descriptor), {
    code: "plugin_ui_only_services_unsupported",
  });
  assertPluginUiHostServiceAvailability({
    scope,
    candidate: candidate({ requires: [{ ...recovery, optional: true }] }),
  });
  let live = true;
  const raw = { isAvailable: () => live };
  const text = {
    service: "crewon.project-texts",
    apiVersion: "1",
    optional: false,
  };
  const port = appendProjectTextRecoveryUiServiceAvailability({
    recovery: raw,
    fallback: appendProjectTextUiServiceAvailability({
      texts: { isAvailable: () => true },
    }),
  });
  raw.isAvailable = () => false;
  assertPluginUiHostServiceAvailability({
    scope,
    candidate: candidate({ requires: [recovery, text] }),
    hostUiServices: port,
  });
  live = false;
  rejectsUnavailable(() =>
    assertPluginUiHostServiceAvailability({
      scope,
      candidate: actual,
      hostUiServices: port,
    }),
  );
  assertPluginUiHostServiceAvailability({
    scope,
    candidate: candidate({ requires: [text] }),
    hostUiServices: port,
  });
  for (const requirement of [
    { ...recovery, apiVersion: "2" },
    { ...recovery, service: "example.crewon.project-text-recovery" },
  ])
    assert.throws(
      () =>
        assertUiOnlyServiceDeclarations(
          descriptor({ requires: [requirement] }),
          port,
        ),
      { code: "plugin_ui_only_services_unsupported" },
    );
  const paid = candidate({
    requires: [
      {
        service: "crewon.project-generations",
        apiVersion: "1",
        optional: false,
      },
    ],
  });
  assert.throws(() => assertUiOnlyServiceDeclarations(paid.descriptor, port), {
    code: "plugin_ui_only_services_unsupported",
  });
});

test("text UI v1 declarations require their actual owner and preserve older availability without manufacturing paid grants", () => {
  const text = {
    service: "crewon.project-texts",
    apiVersion: "1",
    optional: false,
  };
  const actual = candidate({ requires: [text] });
  assert.throws(() => assertUiOnlyServiceDeclarations(actual.descriptor), {
    code: "plugin_ui_only_services_unsupported",
  });
  const optional = candidate({ requires: [{ ...text, optional: true }] });
  assertPluginUiHostServiceAvailability({ scope, candidate: optional });
  const original = { isAvailable: () => true };
  const fallback = registerProjectGenerationHostAvailability({
    isAvailable: () => false,
  });
  const extended = appendProjectTextUiServiceAvailability({
    texts: original,
    fallback,
  });
  original.isAvailable = () => false;
  assertPluginUiHostServiceAvailability({
    scope,
    candidate: actual,
    hostUiServices: extended,
  });
  const unavailable = appendProjectTextUiServiceAvailability({
    texts: { isAvailable: () => false },
  });
  rejectsUnavailable(() =>
    assertPluginUiHostServiceAvailability({
      scope,
      candidate: actual,
      hostUiServices: unavailable,
    }),
  );
  const paid = candidate({
    requires: [
      {
        service: "crewon.project-generations",
        apiVersion: "1",
        optional: false,
      },
    ],
  });
  assertUiOnlyServiceDeclarations(paid.descriptor, extended);
  rejectsUnavailable(() =>
    assertPluginUiHostServiceAvailability({
      scope,
      candidate: paid,
      hostUiServices: extended,
    }),
  );
  const forged = appendProjectTextUiServiceAvailability({
    texts: registerProjectGenerationHostAvailability({
      isAvailable: () => true,
    }),
  });
  assert.throws(
    () => assertUiOnlyServiceDeclarations(paid.descriptor, forged),
    { code: "plugin_ui_only_services_unsupported" },
  );
  for (const unknown of [
    { ...text, apiVersion: "2" },
    { ...text, service: "example.crewon.project-texts" },
  ])
    assert.throws(
      () =>
        assertUiOnlyServiceDeclarations(
          descriptor({ requires: [unknown] }),
          extended,
        ),
      { code: "plugin_ui_only_services_unsupported" },
    );
  assertUiOnlyServiceDeclarations(descriptor({ node: true, requires: [text] }));
});

test("recovery requires independent actual assembly and never supplies an older owner's binding", () => {
  const recovery = {
    service: "crewon.plugin-ui-recovery",
    apiVersion: "1",
    optional: false,
  };
  const actual = candidate({ requires: [recovery] });
  assertUiOnlyServiceDeclarations(actual.descriptor);
  rejectsUnavailable(() =>
    assertPluginUiHostServiceAvailability({ scope, candidate: actual }),
  );
  let recoveries = 0,
    fallbacks = 0;
  const raw = {
    isAvailable() {
      recoveries++;
      return true;
    },
  };
  const fallback = registerProjectGenerationHostAvailability({
    isAvailable() {
      fallbacks++;
      return false;
    },
  });
  const extended = appendPluginUiRecoveryServiceAvailability({
    recovery: raw,
    fallback,
  });
  raw.isAvailable = () => false;
  assertPluginUiHostServiceAvailability({
    scope,
    candidate: actual,
    hostUiServices: extended,
  });
  assert.equal(recoveries, 1);
  assert.equal(fallbacks, 0);
  const paid = candidate({
    requires: [
      {
        service: "crewon.project-generations",
        apiVersion: "1",
        optional: false,
      },
    ],
  });
  assertUiOnlyServiceDeclarations(paid.descriptor, extended);
  rejectsUnavailable(() =>
    assertPluginUiHostServiceAvailability({
      scope,
      candidate: paid,
      hostUiServices: extended,
    }),
  );
  assert.equal(fallbacks, 1);
  const forgedPaid = appendPluginUiRecoveryServiceAvailability({
    recovery: registerProjectGenerationHostAvailability({
      isAvailable: () => true,
    }),
  });
  assert.throws(
    () => assertUiOnlyServiceDeclarations(paid.descriptor, forgedPaid),
    { code: "plugin_ui_only_services_unsupported" },
  );
  assertUiOnlyServiceDeclarations(
    descriptor({ requires: [{ ...recovery, optional: true }] }),
  );
  for (const requirement of [
    { ...recovery, apiVersion: "2" },
    { ...recovery, service: "example.crewon.plugin-ui-recovery" },
  ])
    assert.throws(
      () =>
        assertUiOnlyServiceDeclarations(
          descriptor({ requires: [requirement] }),
          extended,
        ),
      { code: "plugin_ui_only_services_unsupported" },
    );
});

test("known optional image selection protocol preserves metadata-only installation without granting availability", () => {
  const selection = {
    service: "crewon.project-generation-selections",
    apiVersion: "1",
    optional: true,
  };
  const optional = candidate({ requires: [selection] });
  assertUiOnlyServiceDeclarations(optional.descriptor);
  assertPluginUiHostServiceAvailability({ scope, candidate: optional });
  rejectsUnavailable(() =>
    assertPluginUiHostServiceAvailability({
      scope,
      candidate: candidate({ requires: [{ ...selection, optional: false }] }),
    }),
  );
  let calls = 0;
  const unavailable = capturePluginUiHostServiceAvailability({
    isAvailable() {
      calls++;
      return false;
    },
  });
  assertPluginUiHostServiceAvailability({
    scope,
    candidate: optional,
    hostUiServices: unavailable,
  });
  assert.equal(calls, 0);
  rejectsUnavailable(() =>
    assertPluginUiHostServiceAvailability({
      scope,
      candidate: candidate({ requires: [{ ...selection, optional: false }] }),
      hostUiServices: unavailable,
    }),
  );
  for (const requirement of [
    { ...selection, apiVersion: "2" },
    { ...selection, service: "example.crewon.project-generation-selections" },
  ])
    assert.throws(
      () =>
        assertUiOnlyServiceDeclarations(
          descriptor({ requires: [requirement] }),
        ),
      { code: "plugin_ui_only_services_unsupported" },
    );
});
test("selection extension cannot override or manufacture an older paid availability marker", () => {
  const paid = {
    service: "crewon.project-generations",
    apiVersion: "1",
    optional: false,
  };
  const actual = candidate({ requires: [paid] });
  const fallback = registerProjectGenerationHostAvailability(
    Object.freeze({ isAvailable: () => false }),
  );
  const extended = appendProjectGenerationSelectionUiServiceAvailability({
    selection: { isAvailable: () => true },
    fallback,
  });
  assertUiOnlyServiceDeclarations(actual.descriptor, extended);
  rejectsUnavailable(() =>
    assertPluginUiHostServiceAvailability({
      scope,
      candidate: actual,
      hostUiServices: extended,
    }),
  );
  const falseBrand = appendProjectGenerationSelectionUiServiceAvailability({
    selection: registerProjectGenerationHostAvailability({
      isAvailable: () => true,
    }),
  });
  assert.throws(
    () => assertUiOnlyServiceDeclarations(actual.descriptor, falseBrand),
    { code: "plugin_ui_only_services_unsupported" },
  );
});

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
