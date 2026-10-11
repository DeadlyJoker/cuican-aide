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

test("conversation publication is an independent exact metadata approval and leaves older serialized approvals unchanged", () => {
  const original = {
    version: DESKTOP_PROJECT_HISTORY_VERSION,
    pluginUi: grant,
  };
  const parsed = parseDesktopProjectHistoryConfiguration(original, options);
  assert.equal(Object.hasOwn(parsed, "conversations"), false);
  const input = {
    version: DESKTOP_PROJECT_HISTORY_VERSION,
    conversations: grant,
  };
  assert.deepEqual(
    parseDesktopProjectHistoryConfiguration(input, options),
    input,
  );
  assert.throws(() =>
    parseDesktopProjectHistoryConfiguration(
      {
        ...input,
        conversations: {
          publications: [
            { ...source, packageDigest: `sha256:${"f".repeat(64)}` },
          ],
        },
      },
      options,
    ),
  );
  assert.throws(() =>
    parseDesktopProjectHistoryConfiguration(
      {
        ...input,
        conversations: { publications: [source], actor: {} },
      },
      options,
    ),
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

test("legacy result identity retains its exact three-field serialized approval", () => {
  const parsed = parseDesktopProjectHistoryConfiguration(valid, options);
  assert.equal(
    JSON.stringify(parsed.resultSelections!.identities),
    JSON.stringify(valid.resultSelections.identities),
  );
  assert.equal(
    Object.hasOwn(parsed.resultSelections!.identities[0]!, "pluginId"),
    false,
  );
});

test("explicit Short and Krea identities with the same version and digests remain separate", () => {
  const identity = valid.resultSelections.identities[0]!;
  const identities = [
    { pluginId: "crewon.short-drama", ...identity },
    { pluginId: "crewon.comfyui-krea2", ...identity },
  ];
  const parsed = parseDesktopProjectHistoryConfiguration(
    {
      ...valid,
      resultSelections: { ...valid.resultSelections, identities },
    },
    options,
  );
  assert.deepEqual(parsed.resultSelections!.identities, identities);
  assert.ok(Object.isFrozen(parsed.resultSelections!.identities[0]));
});

test("legacy and explicit Krea duplicate approval is rejected after normalization", () => {
  const identity = valid.resultSelections.identities[0]!;
  for (const identities of [
    [identity, { ...identity, pluginId: "crewon.comfyui-krea2" }],
    [{ pluginId: "crewon.comfyui-krea2", ...identity }, identity],
    [
      { pluginId: "crewon.short-drama", ...identity },
      { ...identity, pluginId: "crewon.short-drama" },
    ],
  ])
    assert.throws(
      () =>
        parseDesktopProjectHistoryConfiguration(
          {
            ...valid,
            resultSelections: { ...valid.resultSelections, identities },
          },
          options,
        ),
      { code: "desktop_project_history_configuration_invalid" },
    );
});

test("result identities cannot name arbitrary plugins or explicitly undefined identities", () => {
  for (const pluginId of [
    "other.provider",
    "",
    "CREWON.SHORT-DRAMA",
    null,
    undefined,
    1,
  ])
    assert.throws(
      () =>
        parseDesktopProjectHistoryConfiguration(
          {
            ...valid,
            resultSelections: {
              ...valid.resultSelections,
              identities: [
                { ...valid.resultSelections.identities[0], pluginId },
              ],
            },
          },
          options,
        ),
      { code: "desktop_project_history_configuration_invalid" },
    );
  let reads = 0;
  const identity = { ...valid.resultSelections.identities[0] };
  Object.defineProperty(identity, "pluginId", {
    enumerable: true,
    get() {
      reads++;
      return "crewon.short-drama";
    },
  });
  assert.throws(() =>
    parseDesktopProjectHistoryConfiguration(
      {
        ...valid,
        resultSelections: { ...valid.resultSelections, identities: [identity] },
      },
      options,
    ),
  );
  assert.equal(reads, 0);
});

test("text UI opt-in pins its own publications/store while missing optional fields serialize unchanged", () => {
  const textOnly = {
    version: DESKTOP_PROJECT_HISTORY_VERSION,
    textArtifacts: { version: "crewon.project-text.v1" },
    textUi: grant,
  };
  const parsed = parseDesktopProjectHistoryConfiguration(textOnly, options);
  assert.deepEqual(parsed, textOnly);
  assert.equal(parsed.pluginUi, undefined);
  for (const invalid of [
    { ...textOnly, textArtifacts: undefined },
    { ...textOnly, textArtifacts: { version: "crewon.project-text.v2" } },
    {
      ...textOnly,
      textUi: {
        publications: [
          { ...source, packageDigest: `sha256:${"f".repeat(64)}` },
        ],
      },
    },
    {
      ...textOnly,
      textUi: { publications: [{ ...source, actorId: "injected" }] },
    },
  ])
    assert.throws(() =>
      parseDesktopProjectHistoryConfiguration(invalid, options),
    );
  assert.equal(
    JSON.stringify(
      parseDesktopProjectHistoryConfiguration(
        { version: DESKTOP_PROJECT_HISTORY_VERSION, pluginUi: grant },
        options,
      ),
    ),
    JSON.stringify({
      version: DESKTOP_PROJECT_HISTORY_VERSION,
      pluginUi: grant,
    }),
  );
});

test("text recovery is a separate opt-in pinned to an existing exact text UI publication", () => {
  const original = {
    version: DESKTOP_PROJECT_HISTORY_VERSION,
    textArtifacts: { version: "crewon.project-text.v1" },
    textUi: grant,
  };
  assert.equal(
    parseDesktopProjectHistoryConfiguration(original, options).textRecovery,
    undefined,
  );
  const enabled = { ...original, textRecovery: grant };
  assert.deepEqual(
    parseDesktopProjectHistoryConfiguration(enabled, options),
    enabled,
  );
  for (const invalid of [
    { ...enabled, textUi: undefined },
    { ...enabled, textArtifacts: undefined },
    {
      ...enabled,
      textRecovery: {
        publications: [{ ...source, contributionId: "another-module" }],
      },
    },
    {
      ...enabled,
      textRecovery: {
        publications: [
          { ...source, packageDigest: `sha256:${"e".repeat(64)}` },
        ],
      },
    },
    {
      ...enabled,
      textRecovery: { publications: [{ ...source, actorId: "forged" }] },
    },
  ])
    assert.throws(() =>
      parseDesktopProjectHistoryConfiguration(invalid, options),
    );
});

test("Native conversation ownership is explicit detached approval and cannot leak into other grants", () => {
  const input = {
    version: DESKTOP_PROJECT_HISTORY_VERSION,
    conversations: {
      publications: [{ ...source }],
      projectOwnership: "plugin-project-v1",
    },
  };
  const parsed = parseDesktopProjectHistoryConfiguration(input, options);
  assert.equal(parsed.conversations!.projectOwnership, "plugin-project-v1");
  input.conversations.publications[0]!.pluginId = "changed";
  assert.equal(
    parsed.conversations!.publications[0]!.pluginId,
    source.pluginId,
  );
  for (const projectOwnership of [
    undefined,
    null,
    true,
    "legacy",
    "plugin-project-v2",
    {},
  ])
    assert.throws(() =>
      parseDesktopProjectHistoryConfiguration(
        {
          version: DESKTOP_PROJECT_HISTORY_VERSION,
          conversations: { ...grant, projectOwnership },
        },
        options,
      ),
    );
  for (const field of ["pluginUi", "textUi", "textPlans"])
    assert.throws(() =>
      parseDesktopProjectHistoryConfiguration(
        {
          version: DESKTOP_PROJECT_HISTORY_VERSION,
          [field]: { ...grant, projectOwnership: "plugin-project-v1" },
        },
        options,
      ),
    );
  assert.throws(() =>
    parseDesktopProjectHistoryConfiguration(
      {
        version: DESKTOP_PROJECT_HISTORY_VERSION,
        conversations: {
          publications: [{ ...source, pluginId: "unapproved" }],
          projectOwnership: "plugin-project-v1",
        },
      },
      options,
    ),
  );
  let reads = 0;
  assert.throws(() =>
    parseDesktopProjectHistoryConfiguration(
      {
        version: DESKTOP_PROJECT_HISTORY_VERSION,
        conversations: {
          ...grant,
          get projectOwnership() {
            reads++;
            return "plugin-project-v1";
          },
        },
      },
      options,
    ),
  );
  assert.equal(reads, 0);
});

test("Native metadata ownership applies only to its exact approved original creation lane", () => {
  const parsed = parseDesktopProjectHistoryConfiguration(
    {
      version: DESKTOP_PROJECT_HISTORY_VERSION,
      pluginUi: { ...grant, creationOwnership: "plugin-project-v1" },
    },
    options,
  );
  assert.equal(parsed.pluginUi!.creationOwnership, "plugin-project-v1");
  for (const creationOwnership of [
    undefined,
    null,
    true,
    "plugin-project-v2",
    {},
  ])
    assert.throws(() =>
      parseDesktopProjectHistoryConfiguration(
        {
          version: DESKTOP_PROJECT_HISTORY_VERSION,
          pluginUi: { ...grant, creationOwnership },
        },
        options,
      ),
    );
  for (const field of ["textUi", "conversations", "textPlans"])
    assert.throws(() =>
      parseDesktopProjectHistoryConfiguration(
        {
          version: DESKTOP_PROJECT_HISTORY_VERSION,
          [field]: { ...grant, creationOwnership: "plugin-project-v1" },
        },
        options,
      ),
    );
  assert.throws(() =>
    parseDesktopProjectHistoryConfiguration(
      {
        version: DESKTOP_PROJECT_HISTORY_VERSION,
        pluginUi: {
          publications: [{ ...source, pluginId: "unapproved" }],
          creationOwnership: "plugin-project-v1",
        },
      },
      options,
    ),
  );
  let reads = 0;
  assert.throws(() =>
    parseDesktopProjectHistoryConfiguration(
      {
        version: DESKTOP_PROJECT_HISTORY_VERSION,
        pluginUi: {
          ...grant,
          get creationOwnership() {
            reads++;
            return "plugin-project-v1";
          },
        },
      },
      options,
    ),
  );
  assert.equal(reads, 0);
});
