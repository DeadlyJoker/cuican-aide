import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createPluginCompositionLock,
  PLUGIN_COMPOSITION_LOCK_SCHEMA,
} from "./plugin-composition-lock.ts";
import { planPluginCompositionTransition } from "./plugin-composition-transition.ts";

const digester = {
  sha256: (body: string) =>
    `sha256:${createHash("sha256").update(body).digest("hex")}`,
};
function fixture() {
  const nodes = ["source", "editor", "viewer", "independent"].map(
    (name, index) => ({
      pluginId: `example.${name}`,
      publisherId: "example",
      version: "1.0.0",
      packageDigest: `sha256:${String(index + 1).repeat(64)}`,
      hostApi: "crewon.plugin-host.v1" as const,
      selectionRevision: 1,
      requires: [] as {
        service: string;
        apiVersion: string;
        optional: boolean;
      }[],
      provides: [] as { service: string; apiVersion: string }[],
    }),
  );
  nodes[0]!.provides = [{ service: "story.source", apiVersion: "1" }];
  nodes[1]!.requires = [
    { service: "story.source", apiVersion: "1", optional: true },
  ];
  nodes[1]!.provides = [{ service: "story.edited", apiVersion: "1" }];
  nodes[2]!.requires = [
    { service: "story.edited", apiVersion: "1", optional: false },
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
    nodes,
    hostServices: [] as {
      service: string;
      apiVersion: string;
      implementationId: string;
      implementationRevision: number;
    }[],
  };
}
const lock = (recipe: ReturnType<typeof fixture>) =>
  createPluginCompositionLock(recipe, digester);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test("cold composition prepares providers before consumers; identical and revision-only locks retain all instances", () => {
  const recipe = fixture(),
    initial = lock(recipe);
  const cold = planPluginCompositionTransition(null, initial, digester);
  assert.deepEqual(cold.withdrawOrder, []);
  assert.deepEqual(cold.prepareOrder, [
    "example.source",
    "example.editor",
    "example.independent",
    "example.viewer",
  ]);
  assert.equal(cold.previousLockDigest, null);
  assert.deepEqual(
    planPluginCompositionTransition(initial, initial, digester)
      .affectedPluginIds,
    [],
  );
  recipe.revision = 4;
  const retained = planPluginCompositionTransition(
    initial,
    lock(recipe),
    digester,
  );
  assert.deepEqual(retained.prepareOrder, []);
  assert.deepEqual(retained.withdrawOrder, []);
  assert.equal(retained.retainedPluginIds.length, 4);
});

test("provider upgrade withdraws transitive consumers first and retains the unrelated plugin", () => {
  const recipe = fixture(),
    initial = lock(recipe);
  recipe.revision++;
  Object.assign(recipe.nodes[0]!, {
    version: "2.0.0",
    packageDigest: `sha256:${"a".repeat(64)}`,
    selectionRevision: 2,
  });
  const plan = planPluginCompositionTransition(initial, lock(recipe), digester);
  assert.deepEqual(plan.withdrawOrder, [
    "example.viewer",
    "example.editor",
    "example.source",
  ]);
  assert.deepEqual(plan.prepareOrder, [
    "example.source",
    "example.editor",
    "example.viewer",
  ]);
  assert.deepEqual(plan.retainedPluginIds, ["example.independent"]);
  assert.ok(Object.isFrozen(plan));
  for (const values of [
    plan.affectedPluginIds,
    plan.withdrawOrder,
    plan.prepareOrder,
    plan.retainedPluginIds,
  ])
    assert.ok(Object.isFrozen(values));
});

test("optional dependency removal and return each rebuild the consumer subtree", () => {
  const recipe = fixture(),
    initial = lock(recipe);
  recipe.nodes.shift();
  recipe.revision++;
  const absent = lock(recipe);
  const removal = planPluginCompositionTransition(initial, absent, digester);
  assert.deepEqual(removal.withdrawOrder, [
    "example.viewer",
    "example.editor",
    "example.source",
  ]);
  assert.deepEqual(removal.prepareOrder, ["example.editor", "example.viewer"]);
  const returned = fixture();
  returned.revision = 3;
  const restoration = planPluginCompositionTransition(
    absent,
    lock(returned),
    digester,
  );
  assert.deepEqual(restoration.withdrawOrder, [
    "example.viewer",
    "example.editor",
  ]);
  assert.deepEqual(restoration.prepareOrder, [
    "example.source",
    "example.editor",
    "example.viewer",
  ]);
});

test("host implementation changes reach only its consumers; unrelated host changes do not restart plugins", () => {
  const recipe = fixture();
  recipe.hostServices = [
    {
      service: "host.clock",
      apiVersion: "1",
      implementationId: "clock-1",
      implementationRevision: 1,
    },
  ];
  recipe.nodes[1]!.requires.push({
    service: "host.clock",
    apiVersion: "1",
    optional: false,
  });
  const initial = lock(recipe);
  recipe.revision++;
  recipe.hostServices[0]!.implementationRevision++;
  const changed = lock(recipe);
  assert.deepEqual(
    planPluginCompositionTransition(initial, changed, digester).prepareOrder,
    ["example.editor", "example.viewer"],
  );
  recipe.revision++;
  recipe.hostServices.push({
    service: "host.unused",
    apiVersion: "1",
    implementationId: "unused",
    implementationRevision: 1,
  });
  assert.deepEqual(
    planPluginCompositionTransition(changed, lock(recipe), digester)
      .affectedPluginIds,
    [],
  );
});

test("selection revision changes require fresh preparation; epoch replacement affects all instances", () => {
  const recipe = fixture(),
    initial = lock(recipe);
  recipe.revision++;
  recipe.nodes[3]!.selectionRevision++;
  assert.deepEqual(
    planPluginCompositionTransition(initial, lock(recipe), digester)
      .prepareOrder,
    ["example.independent"],
  );
  recipe.scope.authorityEpoch = "epoch-2";
  const plan = planPluginCompositionTransition(initial, lock(recipe), digester);
  assert.equal(plan.retainedPluginIds.length, 0);
  assert.equal(plan.withdrawOrder.length, 4);
  assert.equal(plan.prepareOrder.length, 4);
});

test("consumer rebinding to a different provider includes old and desired dependency identities", () => {
  const recipe = fixture(),
    initial = lock(recipe);
  recipe.revision++;
  const old = recipe.nodes[0]!;
  old.provides = [];
  const replacement = copy(old);
  Object.assign(replacement, {
    pluginId: "example.newsource",
    packageDigest: `sha256:${"e".repeat(64)}`,
    provides: [{ service: "story.source", apiVersion: "1" }],
  });
  recipe.nodes.push(replacement);
  const plan = planPluginCompositionTransition(initial, lock(recipe), digester);
  assert.ok(
    plan.withdrawOrder.indexOf("example.editor") <
      plan.withdrawOrder.indexOf("example.source"),
  );
  assert.ok(
    plan.prepareOrder.indexOf("example.newsource") <
      plan.prepareOrder.indexOf("example.editor"),
  );
  assert.deepEqual(plan.retainedPluginIds, ["example.independent"]);
});

test("foreign profile, stale revisions, tampered graphs and accessors are rejected before any plan", () => {
  const recipe = fixture(),
    initial = lock(recipe);
  for (const field of ["tenantId", "spaceId", "profileId"] as const) {
    const foreign = copy(recipe);
    foreign.scope[field] += "-foreign";
    foreign.revision++;
    assert.throws(
      () => planPluginCompositionTransition(initial, lock(foreign), digester),
      /transition_scope_conflict/,
    );
  }
  recipe.nodes[3]!.selectionRevision++;
  assert.throws(
    () => planPluginCompositionTransition(initial, lock(recipe), digester),
    /transition_revision_conflict/,
  );
  recipe.revision++;
  const corrupt = copy(lock(recipe));
  (corrupt.edges as unknown[]).pop();
  assert.throws(() =>
    planPluginCompositionTransition(initial, corrupt, digester),
  );
  let reads = 0;
  const getter = {
    ...initial,
    get revision() {
      reads++;
      return 1;
    },
  };
  assert.throws(() =>
    planPluginCompositionTransition(getter, initial, digester),
  );
  assert.equal(reads, 0);
});

test("canonical input ordering and caller mutation cannot alter an already returned plan", () => {
  const recipe = fixture(),
    initial = lock(recipe);
  recipe.revision++;
  recipe.nodes[0]!.selectionRevision++;
  const mutable = copy(lock(recipe));
  const plan = planPluginCompositionTransition(
    copy(initial),
    mutable,
    digester,
  );
  recipe.nodes.reverse();
  assert.deepEqual(
    plan,
    planPluginCompositionTransition(initial, lock(recipe), digester),
  );
  (mutable.nodes as unknown[]).length = 0;
  assert.equal(plan.prepareOrder.length, 3);
});
