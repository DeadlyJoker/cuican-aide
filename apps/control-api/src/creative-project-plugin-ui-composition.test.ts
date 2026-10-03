import assert from "node:assert/strict";
import test from "node:test";
import {
  captureCreativeProjectPluginUiConfig,
  assertCreativeProjectPluginPublications,
} from "./creative-project-plugin-ui-composition.ts";

const publication = {
  pluginId: "fixture.drama",
  packageDigest: "sha256:" + "d".repeat(64),
  contributionId: "workbench",
};

test("absent metadata publication config is disabled; valid config pins detached immutable exact tuples", () => {
  assert.equal(captureCreativeProjectPluginUiConfig(undefined), undefined);
  const original = { publications: [{ ...publication }] };
  const captured = captureCreativeProjectPluginUiConfig(original)!;
  assert.deepEqual(captured, original);
  assert.ok(Object.isFrozen(captured));
  assert.ok(Object.isFrozen(captured.publications));
  assert.ok(Object.isFrozen(captured.publications[0]));
  assert.ok(!Object.isFrozen(original));
  assert.ok(!Object.isFrozen(original.publications));
  assert.ok(!Object.isFrozen(original.publications[0]));
  original.publications[0]!.contributionId = "changed";
  original.publications.push({ ...publication, pluginId: "other.drama" });
  assert.deepEqual(captured.publications, [publication]);
});

test("plugin and contribution ids both use the installation namespace grammar", () => {
  for (const field of ["pluginId", "contributionId"] as const) {
    for (const value of [
      "",
      "with space",
      " workbench",
      "workbench ",
      "work\nbench",
      "work/bench",
    ]) {
      assert.throws(() =>
        captureCreativeProjectPluginUiConfig({
          publications: [{ ...publication, [field]: value }],
        }),
      );
    }
  }
});

test("publication capture rejects getters at every input layer without invoking them", () => {
  let getterCalls = 0;
  const getter = () => {
    getterCalls++;
    return publication;
  };
  const arrayAccessor = [{ ...publication }];
  Object.defineProperty(arrayAccessor, "0", { enumerable: true, get: getter });
  const itemAccessor = { ...publication };
  Object.defineProperty(itemAccessor, "contributionId", {
    enumerable: true,
    get: getter,
  });
  const configAccessor = Object.defineProperty({}, "publications", {
    enumerable: true,
    get: getter,
  });
  const inherited = Object.create({
    get publications() {
      return getter();
    },
  });
  for (const value of [
    configAccessor,
    inherited,
    { publications: arrayAccessor },
    { publications: [itemAccessor] },
  ]) {
    assert.throws(() => captureCreativeProjectPluginUiConfig(value));
  }
  assert.equal(getterCalls, 0);
});

test("publication capture rejects malformed, sparse, augmented and duplicate allowlists", () => {
  const augmented = [{ ...publication }];
  Object.defineProperty(augmented, "extra", { enumerable: true, value: true });
  const symbolic = [{ ...publication }];
  Object.defineProperty(symbolic, Symbol("extra"), { value: true });
  const sparse = new Array(1);
  const nonenumerable = [{ ...publication }];
  Object.defineProperty(nonenumerable, "0", {
    enumerable: false,
    value: publication,
  });
  for (const value of [
    null,
    {},
    { publications: [], extra: true },
    { publications: [] },
    { publications: new Array(33).fill(publication) },
    { publications: sparse },
    { publications: augmented },
    { publications: symbolic },
    { publications: nonenumerable },
    { publications: [{ ...publication, extra: true }] },
    { publications: [publication, { ...publication }] },
    { publications: [{ ...publication, packageDigest: "not-a-digest" }] },
  ]) {
    assert.throws(() => captureCreativeProjectPluginUiConfig(value));
  }
});

test("deployment approval must match the exact plugin and digest and never substitutes another package", () => {
  const configuration = captureCreativeProjectPluginUiConfig({
    publications: [publication],
  });
  assert.doesNotThrow(() =>
    assertCreativeProjectPluginPublications(undefined, undefined),
  );
  assert.doesNotThrow(() =>
    assertCreativeProjectPluginPublications(configuration, [publication]),
  );
  for (const approved of [
    undefined,
    [],
    [{ ...publication, pluginId: "other.drama" }],
    [{ ...publication, packageDigest: "sha256:" + "a".repeat(64) }],
  ]) {
    assert.throws(
      () => assertCreativeProjectPluginPublications(configuration, approved),
      /creative_project_plugin_publication_unapproved/u,
    );
  }
});
