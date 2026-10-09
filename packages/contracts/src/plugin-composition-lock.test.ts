import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createPluginCompositionLock,
  parsePluginCompositionLock,
  pluginCompositionActivationOrder,
  PLUGIN_COMPOSITION_LOCK_SCHEMA,
} from "./plugin-composition-lock.ts";
import { ContractValidationError } from "./contract-validation-error.ts";

const digester = {
  sha256: (body: string) =>
    `sha256:${createHash("sha256").update(body).digest("hex")}`,
};
const node = (pluginId: string, marker: string) => ({
  pluginId,
  publisherId: "example",
  version: "1.0.0",
  packageDigest: `sha256:${marker.repeat(64)}`,
  hostApi: "crewon.plugin-host.v1",
  selectionRevision: 1,
  requires: [] as { service: string; apiVersion: string; optional: boolean }[],
  provides: [] as { service: string; apiVersion: string }[],
});
function fixture() {
  const provider = node("example.zprovider", "a");
  provider.provides = [{ service: "story.source", apiVersion: "1" }];
  const consumer = node("example.aconsumer", "b");
  consumer.requires = [
    { service: "story.source", apiVersion: "1", optional: false },
    { service: "host.clock", apiVersion: "2", optional: false },
    { service: "story.optional", apiVersion: "1", optional: true },
  ];
  return {
    schemaVersion: PLUGIN_COMPOSITION_LOCK_SCHEMA,
    scope: {
      tenantId: "tenant-1",
      spaceId: "space-1",
      profileId: "profile-1",
      authorityEpoch: "epoch-1",
    },
    revision: 1,
    nodes: [consumer, provider],
    hostServices: [
      {
        service: "host.clock",
        apiVersion: "2",
        implementationId: "clock-1",
        implementationRevision: 7,
      },
    ],
  };
}
function copy<T>(input: T): T {
  return JSON.parse(JSON.stringify(input));
}
function fails(read: () => unknown, code?: string) {
  assert.throws(
    read,
    (error: unknown) =>
      error instanceof ContractValidationError &&
      (!code || error.code === code),
  );
}

test("composition lock captures exact providers, explicit optional absence and deterministic activation order", () => {
  const input = fixture();
  const lock = createPluginCompositionLock(input, digester);
  assert.deepEqual(
    lock.edges.map((e) => e.provider.kind),
    ["host", "absent", "plugin"],
  );
  assert.deepEqual(pluginCompositionActivationOrder(lock, digester), [
    "example.zprovider",
    "example.aconsumer",
  ]);
  assert.deepEqual(parsePluginCompositionLock(lock, digester), lock);
  assert.equal(Object.isFrozen(lock.nodes[0]?.requires), true);
  input.nodes[0]!.requires.length = 0;
  input.scope.tenantId = "changed";
  assert.equal(lock.nodes[0]?.requires.length, 3);
  assert.equal(lock.scope.tenantId, "tenant-1");
});

test("unordered graph metadata has one canonical digest regardless of input ordering", () => {
  const first = fixture();
  const second = copy(first);
  second.nodes.reverse();
  second.nodes[1]!.requires.reverse();
  const lock = createPluginCompositionLock(first, digester);
  assert.deepEqual(createPluginCompositionLock(second, digester), lock);
  const reordered = copy(lock);
  (reordered.edges as unknown[]).reverse();
  (reordered.nodes as unknown[]).reverse();
  assert.deepEqual(parsePluginCompositionLock(reordered, digester), lock);
});

test("zero plugin lock is valid metadata and exposes no synthetic dependencies", () => {
  const input = fixture();
  input.nodes = [];
  input.hostServices = [];
  const lock = createPluginCompositionLock(input, digester);
  assert.deepEqual(lock.edges, []);
  assert.deepEqual(pluginCompositionActivationOrder(lock, digester), []);
});

test("scope, authority epoch, revision and selected package identities are covered by the digest", () => {
  const original = createPluginCompositionLock(fixture(), digester);
  for (const key of [
    "tenantId",
    "spaceId",
    "profileId",
    "authorityEpoch",
  ] as const) {
    const changed = copy(original);
    (changed.scope as Record<string, string>)[key] = "foreign-owner";
    fails(
      () => parsePluginCompositionLock(changed, digester),
      "plugin_composition_digest_mismatch",
    );
  }
  for (const mutate of [
    (v: any) => {
      v.revision++;
    },
    (v: any) => {
      v.nodes[0].selectionRevision++;
    },
    (v: any) => {
      v.nodes[0].publisherId = "other";
    },
    (v: any) => {
      v.nodes[0].version = "2.0.0";
    },
  ]) {
    const changed = copy(original);
    mutate(changed);
    fails(
      () => parsePluginCompositionLock(changed, digester),
      "plugin_composition_digest_mismatch",
    );
  }
});

test("stored dependencies cannot be missing, duplicated, forged, or silently repaired", () => {
  const original = createPluginCompositionLock(fixture(), digester);
  for (const mutate of [
    (v: any) => {
      v.edges.pop();
    },
    (v: any) => {
      v.edges.push(v.edges[0]);
    },
    (v: any) => {
      v.edges[2].provider.packageDigest = `sha256:${"c".repeat(64)}`;
    },
    (v: any) => {
      v.edges[0].provider.implementationRevision++;
    },
    (v: any) => {
      v.edges[2].provider = { kind: "absent" };
    },
    (v: any) => {
      v.edges[1].provider = {
        kind: "plugin",
        pluginId: "example.zprovider",
        packageDigest: `sha256:${"a".repeat(64)}`,
      };
    },
  ]) {
    const changed = copy(original);
    mutate(changed);
    fails(
      () => parsePluginCompositionLock(changed, digester),
      "plugin_composition_binding_mismatch",
    );
  }
});

test("required version mismatch rejects and optional mismatch is captured as absent", () => {
  const input = fixture();
  input.nodes[1]!.provides[0]!.apiVersion = "2";
  fails(
    () => createPluginCompositionLock(input, digester),
    "plugin_composition_dependency_unavailable",
  );
  input.nodes[0]!.requires[0]!.optional = true;
  const lock = createPluginCompositionLock(input, digester);
  assert.equal(
    lock.edges.find((e) => e.service === "story.source")?.provider.kind,
    "absent",
  );
});

test("host protocol versions coexist and each consumer binds its exact implementation revision", () => {
  const input = fixture();
  input.nodes[1]!.requires = [
    { service: "host.clock", apiVersion: "1", optional: false },
  ];
  input.hostServices.push({
    service: "host.clock",
    apiVersion: "1",
    implementationId: "clock-legacy",
    implementationRevision: 3,
  });
  const lock = createPluginCompositionLock(input, digester);
  assert.deepEqual(
    lock.edges
      .filter((edge) => edge.service === "host.clock")
      .map((edge) => edge.provider),
    [
      { kind: "host", implementationId: "clock-1", implementationRevision: 7 },
      {
        kind: "host",
        implementationId: "clock-legacy",
        implementationRevision: 3,
      },
    ],
  );
  assert.deepEqual(parsePluginCompositionLock(lock, digester), lock);
});

test("duplicate plugin providers, host shadowing, exact host duplicates and self dependencies fail closed", () => {
  for (const mutate of [
    (v: ReturnType<typeof fixture>) => {
      const other = node("example.other", "c");
      other.provides = [...v.nodes[1]!.provides];
      v.nodes.push(other);
    },
    (v: ReturnType<typeof fixture>) => {
      v.nodes[1]!.provides = [{ service: "host.clock", apiVersion: "1" }];
    },
    (v: ReturnType<typeof fixture>) => {
      v.hostServices.push(v.hostServices[0]!);
    },
    (v: ReturnType<typeof fixture>) => {
      v.nodes[1]!.requires = [
        { service: "story.source", apiVersion: "1", optional: true },
      ];
    },
  ]) {
    const input = fixture();
    mutate(input);
    fails(
      () => createPluginCompositionLock(input, digester),
      "plugin_composition_service_conflict",
    );
  }
});

test("required and present optional cycles reject instead of inventing deferred providers", () => {
  for (const optional of [false, true]) {
    const input = fixture();
    input.nodes[0]!.provides = [{ service: "story.result", apiVersion: "1" }];
    input.nodes[1]!.requires = [
      { service: "story.result", apiVersion: "1", optional },
    ];
    fails(
      () => createPluginCompositionLock(input, digester),
      "plugin_composition_dependency_cycle",
    );
  }
});

test("strict fields, limits, malformed values and duplicate node identities are rejected", () => {
  for (const mutate of [
    (v: any) => {
      v.secret = "private";
    },
    (v: any) => {
      v.nodes[0].actorId = "forged";
    },
    (v: any) => {
      v.nodes[0].packageDigest = "not-a-digest";
    },
    (v: any) => {
      v.nodes[0].hostApi = "crewon.plugin-host.v2";
    },
    (v: any) => {
      v.nodes[0].selectionRevision = 0;
    },
    (v: any) => {
      v.revision = NaN;
    },
    (v: any) => {
      v.schemaVersion = "unknown";
    },
    (v: any) => {
      v.nodes.push(v.nodes[0]);
    },
    (v: any) => {
      v.nodes[1].packageDigest = v.nodes[0].packageDigest;
    },
    (v: any) => {
      v.nodes = Array.from({ length: 65 }, () => v.nodes[0]);
    },
    (v: any) => {
      v.nodes[0].requires = Array.from(
        { length: 65 },
        () => v.nodes[0].requires[0],
      );
    },
    (v: any) => {
      v.scope.profileId = "x".repeat(512 * 1024);
    },
  ]) {
    const input = fixture();
    mutate(input);
    fails(() => createPluginCompositionLock(input, digester));
  }
});

test("validation never invokes getters or serialization hooks and rejects exotic JSON", () => {
  let calls = 0;
  const getter = fixture();
  Object.defineProperty(getter.scope, "tenantId", {
    enumerable: true,
    get() {
      calls++;
      return "bad";
    },
  });
  const hook = {
    ...fixture(),
    toJSON() {
      calls++;
      return fixture();
    },
  };
  for (const input of [
    getter,
    hook,
    { ...fixture(), nodes: new Array(2) },
    Object.assign(Object.create({ hidden: true }), fixture()),
    { ...fixture(), [Symbol("extra")]: 1 },
  ])
    fails(() => createPluginCompositionLock(input, digester));
  assert.equal(calls, 0);
  fails(() =>
    createPluginCompositionLock(fixture(), { sha256: () => "invalid" }),
  );
});

test("the derived graph and digest must fit the same wire budget as the input parser", () => {
  const input = fixture();
  input.hostServices = Array.from({ length: 32 }, (_, i) => ({
    service: `host.${"x".repeat(80)}.${i}`,
    apiVersion: "1",
    implementationId: `implementation-${i}`,
    implementationRevision: 1,
  }));
  input.nodes = Array.from({ length: 64 }, (_, i) => ({
    ...node(`example.p${i}`, "a"),
    packageDigest: digester.sha256(`package-${i}`),
    requires: input.hostServices.map((host) => ({
      service: host.service,
      apiVersion: host.apiVersion,
      optional: false,
    })),
  }));
  assert.equal(Buffer.byteLength(JSON.stringify(input)) < 512 * 1024, true);
  fails(() => createPluginCompositionLock(input, digester));
});
