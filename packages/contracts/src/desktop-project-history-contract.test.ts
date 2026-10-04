import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_PROJECT_HISTORY_VERSION,
  parseDesktopProjectHistoryConfiguration,
} from "./desktop-project-history-contract.ts";

// Explicit schema fixtures; these digests do not claim a production package identity.
const source = {
  pluginId: "test.native-history-module",
  packageDigest: `sha256:${"a".repeat(64)}`,
  contributionId: "workbench",
};
const options = { publications: [source] };
const grant = { publications: [source] };
const recovery = {
  version: "crewon.plugin-ui-recovery.v1",
  publications: [
    {
      ...source,
      actions: ["crewon.project-generation-selections.v1.selectConceptImage"],
    },
  ],
};
const valid = {
  version: DESKTOP_PROJECT_HISTORY_VERSION,
  pluginUi: grant,
  generationReads: { version: "crewon.project-generation-read.v1" },
  generationReadUi: grant,
  resultSelections: {
    version: "crewon.project-concept-selection.v1",
    adapter: "comfyui-krea2",
    identities: [
      {
        pluginVersion: "1.0.0",
        manifestDigest: `sha256:${"b".repeat(64)}`,
        implementationDigest: `sha256:${"c".repeat(64)}`,
      },
    ],
  },
  selectionUi: grant,
  uiRecovery: recovery,
};

test("Native project data captures detached frozen independent grants without execution fields", () => {
  const input = structuredClone(valid);
  const parsed = parseDesktopProjectHistoryConfiguration(input, options);
  assert.deepEqual(parsed, valid);
  input.pluginUi.publications[0]!.contributionId = "changed";
  assert.equal(parsed.pluginUi!.publications[0]!.contributionId, "workbench");
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.resultSelections!.identities[0]));
  assert.ok(Object.isFrozen(parsed.uiRecovery!.publications[0]!.actions));
});

test("metadata-only approval neither adds history nor selection nor recovery", () => {
  const value = { version: DESKTOP_PROJECT_HISTORY_VERSION, pluginUi: grant };
  assert.deepEqual(
    parseDesktopProjectHistoryConfiguration(value, options),
    value,
  );
});

test("Native metadata recovery binds the exact project module without a history or business action grant", () => {
  const value = {
    version: DESKTOP_PROJECT_HISTORY_VERSION,
    pluginUi: grant,
    uiRecovery: { ...recovery, publications: [{ ...source, actions: [] }] },
  };
  const parsed = parseDesktopProjectHistoryConfiguration(value, options);
  assert.deepEqual(parsed, value);
  assert.ok(Object.isFrozen(parsed.uiRecovery!.publications[0]!.actions));
  assert.equal(parsed.generationReads, undefined);
  assert.equal(parsed.resultSelections, undefined);
  for (const changed of [
    { ...value, pluginUi: undefined },
    {
      ...value,
      uiRecovery: {
        ...recovery,
        publications: [{ ...source, contributionId: "other", actions: [] }],
      },
    },
    { ...value, uiRecovery: recovery },
  ])
    assert.throws(() =>
      parseDesktopProjectHistoryConfiguration(changed, options),
    );
});

for (const field of [
  "authorization",
  "actor",
  "scope",
  "pluginGenerations",
  "pluginQueries",
  "baseUrl",
  "price",
  "wallet",
  "token",
])
  test(`Native approval refuses host execution/identity field ${field}`, () => {
    assert.throws(() =>
      parseDesktopProjectHistoryConfiguration(
        { ...valid, [field]: {} },
        options,
      ),
    );
  });

test("every business source publication requires its own exact public package approval", () => {
  for (const field of ["pluginUi", "generationReadUi", "selectionUi"] as const)
    for (const changed of [
      { ...source, pluginId: "other.source" },
      { ...source, packageDigest: `sha256:${"d".repeat(64)}` },
    ])
      assert.throws(() =>
        parseDesktopProjectHistoryConfiguration(
          { ...valid, [field]: { publications: [changed] } },
          options,
        ),
      );
});

test("metadata or read approval cannot imply selection recovery authority", () => {
  const { selectionUi: _selection, ...withoutSelection } = valid;
  assert.throws(() =>
    parseDesktopProjectHistoryConfiguration(withoutSelection, options),
  );
  for (const changed of [
    { ...source, contributionId: "other-module" },
    { ...source, packageDigest: `sha256:${"d".repeat(64)}` },
  ])
    assert.throws(() =>
      parseDesktopProjectHistoryConfiguration(
        {
          ...valid,
          uiRecovery: {
            ...recovery,
            publications: [
              { ...changed, actions: recovery.publications[0]!.actions },
            ],
          },
        },
        options,
      ),
    );
});

test("recovery cannot approve generation or supplier-query actions in Native", () => {
  for (const action of [
    "crewon.project-generations.v1.generateConcept",
    "crewon.project-generation-queries.v1.queryConceptGeneration",
  ])
    assert.throws(() =>
      parseDesktopProjectHistoryConfiguration(
        {
          ...valid,
          uiRecovery: {
            ...recovery,
            publications: [{ ...source, actions: [action] }],
          },
        },
        options,
      ),
    );
});

test("missing or malformed reader, verifier identity, versions and duplicate approvals refuse", () => {
  const { generationReads: _read, ...withoutReader } = valid;
  for (const input of [
    withoutReader,
    { ...valid, resultSelections: undefined },
    { version: DESKTOP_PROJECT_HISTORY_VERSION },
    { ...valid, version: "crewon.desktop-project-history.v2" },
    { ...valid, pluginUi: { publications: [source, source] } },
    { ...valid, uiRecovery: { ...recovery, publications: [] } },
    {
      ...valid,
      resultSelections: { ...valid.resultSelections, identities: [] },
    },
    {
      ...valid,
      resultSelections: {
        ...valid.resultSelections,
        identities: [
          {
            ...valid.resultSelections.identities[0],
            pluginVersion: "1.0.0-beta",
          },
        ],
      },
    },
  ])
    assert.throws(() =>
      parseDesktopProjectHistoryConfiguration(input, options),
    );
});

test("approval capture refuses accessors without invoking them and bounded oversized input", () => {
  let invoked = false;
  const input = { ...valid };
  Object.defineProperty(input, "pluginUi", {
    enumerable: true,
    get: () => {
      invoked = true;
      return grant;
    },
  });
  assert.throws(() => parseDesktopProjectHistoryConfiguration(input, options));
  assert.equal(invoked, false);
  assert.throws(() =>
    parseDesktopProjectHistoryConfiguration(
      { ...valid, padding: "x".repeat(64 * 1024) },
      options,
    ),
  );
});
