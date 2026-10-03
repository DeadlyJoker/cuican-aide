import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginTaskAdmissionPin } from "./plugin-task-admission.ts";
import {
  assertProjectGenerationExecutionPublication,
  captureProjectGenerationPublications,
  parseProjectGenerationPublication,
  ProjectGenerationPublicationError,
} from "./project-generation-publication.ts";

const publication = {
  source: {
    pluginId: "example.story",
    packageDigest: `sha256:${"a".repeat(64)}`,
    contributionId: "workbench",
  },
  target: {
    pluginId: "example.image",
    packageDigest: `sha256:${"b".repeat(64)}`,
    contributionId: "studio",
    action: "image.generate",
  },
};
const sourcePin = parsePluginTaskAdmissionPin({
  tenantId: "tenant-1",
  spaceId: "space-1",
  profileId: "profile-1",
  principalId: "principal-1",
  actorId: "actor-1",
  ...publication.source,
  publisherId: "example.story-publisher",
  version: "3.0.0",
  selectionRevision: 2,
  action: "crewon.project-generations.v1.generateConcept",
  authorityEpoch: "source-policy-2",
});
const executionPin = parsePluginTaskAdmissionPin({
  tenantId: sourcePin.tenantId,
  spaceId: sourcePin.spaceId,
  profileId: sourcePin.profileId,
  principalId: sourcePin.principalId,
  actorId: sourcePin.actorId,
  ...publication.target,
  publisherId: "example.image-publisher",
  version: "0.1.0",
  selectionRevision: 7,
  authorityEpoch: "target-policy-8",
});

test("captures a detached deeply frozen exact mapping and does not impose equal publisher, version or authority epoch", () => {
  const original = structuredClone(publication);
  const captured = parseProjectGenerationPublication(original);
  assert.deepEqual(captured, publication);
  assert.notEqual(captured, original);
  assert.notEqual(captured.source, original.source);
  assert.notEqual(captured.target, original.target);
  for (const object of [captured, captured.source, captured.target])
    assert.ok(Object.isFrozen(object));
  original.source.pluginId = "changed.source";
  original.target.action = "changed.action";
  assert.deepEqual(captured, publication);
  assert.doesNotThrow(() =>
    assertProjectGenerationExecutionPublication({
      publication: captured,
      sourcePin,
      executionPin,
    }),
  );
});

test("rejects unknown, hidden, symbol, accessor and private-prototype fields at every mapping depth without invoking getters", () => {
  let reads = 0;
  for (const path of ["publication", "source", "target"] as const) {
    const invalid = (change: (value: Record<string, unknown>) => object) => {
      const value = structuredClone(publication);
      if (path === "publication") return change(value);
      return { ...value, [path]: change(value[path]) };
    };
    for (const value of [
      invalid((record) => ({ ...record, actor: "invented" })),
      invalid((record) => ({ ...record, [Symbol("hidden")]: true })),
      invalid((record) =>
        Object.defineProperty(record, Object.keys(record)[0]!, {
          enumerable: false,
        }),
      ),
      invalid((record) =>
        Object.defineProperty(record, Object.keys(record)[0]!, {
          enumerable: true,
          get() {
            reads++;
            throw new Error("must-not-read");
          },
        }),
      ),
      invalid((record) =>
        Object.assign(Object.create({ private: true }), record),
      ),
    ])
      assert.throws(
        () => parseProjectGenerationPublication(value),
        ProjectGenerationPublicationError,
      );
  }
  assert.equal(reads, 0);
});

test("requires exact source and target records rather than null, arrays or missing fields", () => {
  for (const value of [
    null,
    [],
    {},
    { ...publication, source: null },
    { ...publication, target: [] },
    { ...publication, source: { pluginId: "example.story" } },
    { ...publication, target: { ...publication.source } },
  ])
    assert.throws(
      () => parseProjectGenerationPublication(value),
      /project_generation_publication_invalid/u,
    );
  const nullPrototype = Object.assign(Object.create(null), {
    source: Object.assign(Object.create(null), publication.source),
    target: Object.assign(Object.create(null), publication.target),
  });
  assert.deepEqual(
    parseProjectGenerationPublication(nullPrototype),
    publication,
  );
});

test("bounds namespaces, target action and both digests without coercion or normalization", () => {
  for (const side of ["source", "target"] as const)
    for (const [field, values] of [
      ["pluginId", ["", "../plugin", "UPPER", "a".repeat(129), 1]],
      [
        "contributionId",
        ["", "../contribution", "UPPER", "a".repeat(129), null],
      ],
      [
        "packageDigest",
        [
          "sha256:ABC",
          `sha256:${"A".repeat(64)}`,
          `sha256:${"a".repeat(63)}`,
          `sha256:${"a".repeat(65)}`,
          1,
        ],
      ],
    ] as const)
      for (const value of values)
        assert.throws(
          () =>
            parseProjectGenerationPublication({
              ...publication,
              [side]: { ...publication[side], [field]: value },
            }),
          ProjectGenerationPublicationError,
        );
  for (const action of [
    "",
    "../generate",
    "image.generate?",
    "Image.generate",
    "a".repeat(129),
    null,
  ])
    assert.throws(
      () =>
        parseProjectGenerationPublication({
          ...publication,
          target: { ...publication.target, action },
        }),
      ProjectGenerationPublicationError,
    );
});

test("captures one through thirty-two detached publications and freezes the array", () => {
  const original = Array.from({ length: 32 }, (_, index) => ({
    ...publication,
    source: { ...publication.source, contributionId: `workbench-${index}` },
  }));
  const captured = captureProjectGenerationPublications(original);
  assert.equal(captured.length, 32);
  assert.ok(Object.isFrozen(captured));
  assert.ok(
    captured.every(
      (item) =>
        Object.isFrozen(item) &&
        Object.isFrozen(item.source) &&
        Object.isFrozen(item.target),
    ),
  );
  original.splice(0, original.length);
  assert.equal(captured.length, 32);
  assert.equal(captureProjectGenerationPublications([publication]).length, 1);
});

test("rejects duplicate source tuples even when targets differ; a distinct digest or contribution is a distinct source", () => {
  for (const next of [
    publication,
    {
      ...publication,
      target: { ...publication.target, pluginId: "another.target" },
    },
  ])
    assert.throws(
      () => captureProjectGenerationPublications([publication, next]),
      /project_generation_publication_source_duplicate/u,
    );
  assert.equal(
    captureProjectGenerationPublications([
      publication,
      {
        ...publication,
        source: {
          ...publication.source,
          packageDigest: executionPin.packageDigest,
        },
      },
      {
        ...publication,
        source: { ...publication.source, contributionId: "another-workbench" },
      },
    ]).length,
    3,
  );
});

test("rejects empty, over-budget, sparse, decorated, accessor and subclass arrays without reading indexes", () => {
  let reads = 0;
  class Publications extends Array<unknown> {}
  const accessor = Object.defineProperty([publication], "0", {
    enumerable: true,
    get() {
      reads++;
      throw new Error("must-not-read");
    },
  });
  const hidden = Object.defineProperty([publication], "0", {
    enumerable: false,
  });
  for (const value of [
    null,
    {},
    [],
    Array.from({ length: 33 }, () => publication),
    new Array(1),
    Object.assign([publication], { extra: true }),
    Object.assign([publication], { [Symbol("hidden")]: true }),
    new Publications(publication),
    accessor,
    hidden,
  ])
    assert.throws(
      () => captureProjectGenerationPublications(value),
      /project_generation_publications_invalid/u,
    );
  assert.equal(reads, 0);
});

test("checks all source tuple fields and the exact reserved source action", () => {
  for (const patch of [
    { pluginId: "another.source" },
    { packageDigest: executionPin.packageDigest },
    { contributionId: "another-workbench" },
    { action: "image.generate" },
    { action: "crewon.project-generations.v1.generateconcept" },
  ])
    assert.throws(
      () =>
        assertProjectGenerationExecutionPublication({
          publication,
          sourcePin: { ...sourcePin, ...patch },
          executionPin,
        }),
      /project_generation_execution_publication_mismatch/u,
    );
});

test("checks all target tuple fields and every shared actor/profile boundary", () => {
  for (const patch of [
    { pluginId: "another.target" },
    { packageDigest: sourcePin.packageDigest },
    { contributionId: "another-studio" },
    { action: "image.query" },
    { tenantId: "other-tenant" },
    { spaceId: "other-space" },
    { profileId: "other-profile" },
    { principalId: "other-payer" },
    { actorId: "other-actor" },
  ])
    assert.throws(
      () =>
        assertProjectGenerationExecutionPublication({
          publication,
          sourcePin,
          executionPin: { ...executionPin, ...patch },
        }),
      /project_generation_execution_publication_mismatch/u,
    );
});

test("parses both pins with their existing strict contract and rejects a decorated execution assertion", () => {
  for (const [field, pin] of [
    ["sourcePin", sourcePin],
    ["executionPin", executionPin],
  ] as const)
    for (const invalid of [
      { ...pin, owner: "invented" },
      { ...pin, selectionRevision: 0 },
      { ...pin, authorityEpoch: "" },
    ])
      assert.throws(
        () =>
          assertProjectGenerationExecutionPublication({
            publication,
            sourcePin,
            executionPin,
            [field]: invalid,
          }),
        /project_generation_execution_publication_mismatch/u,
      );
  assert.throws(
    () =>
      assertProjectGenerationExecutionPublication({
        ...{ publication, sourcePin, executionPin },
        payer: "invented",
      } as never),
    /project_generation_execution_publication_mismatch/u,
  );
});
