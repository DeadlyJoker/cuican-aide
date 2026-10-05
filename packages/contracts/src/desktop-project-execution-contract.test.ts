import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_PROJECT_EXECUTION_VERSION,
  parseDesktopProjectExecutionConfiguration,
} from "./desktop-project-execution-contract.ts";
import {
  DESKTOP_PROJECT_HISTORY_VERSION,
  parseDesktopProjectHistoryConfiguration,
} from "./desktop-project-history-contract.ts";

// Schema-only fixtures: no package, execution permission, supplier or funds are issued here.
const source = {
  pluginId: "example.short-drama",
  packageDigest: `sha256:${"a".repeat(64)}`,
  contributionId: "workbench",
};
const target = {
  pluginId: "example.krea2",
  packageDigest: `sha256:${"b".repeat(64)}`,
  contributionId: "studio",
};
const options = { publications: [source] };
const generate = "crewon.project-generations.v1.generateConcept";
const query = "crewon.project-generation-queries.v1.queryConceptGeneration";
const select = "crewon.project-generation-selections.v1.selectConceptImage";
const valid = {
  version: DESKTOP_PROJECT_EXECUTION_VERSION,
  pluginUi: { publications: [source] },
  generationReads: { version: "crewon.project-generation-read.v1" },
  generationReadUi: { publications: [source] },
  resultSelections: {
    version: "crewon.project-concept-selection.v1",
    adapter: "comfyui-krea2",
    identities: [
      {
        pluginVersion: "1.0.0",
        manifestDigest: `sha256:${"c".repeat(64)}`,
        implementationDigest: `sha256:${"d".repeat(64)}`,
      },
    ],
  },
  selectionUi: { publications: [source] },
  pluginGenerations: {
    publications: [{ source, target: { ...target, action: "image.generate" } }],
  },
  pluginQueries: {
    publications: [{ source, target: { ...target, action: "image.query" } }],
  },
  uiRecovery: {
    version: "crewon.plugin-ui-recovery.v1",
    publications: [{ ...source, actions: [generate, query, select] }],
  },
};

test("Native execution data captures exact frozen mappings and three independent recovery lanes", () => {
  const input = structuredClone(valid);
  const parsed = parseDesktopProjectExecutionConfiguration(input, options);
  assert.deepEqual(parsed, valid);
  input.pluginGenerations.publications[0]!.target.action = "other.action";
  input.uiRecovery.publications[0]!.actions.pop();
  assert.equal(
    parsed.pluginGenerations!.publications[0]!.target.action,
    "image.generate",
  );
  assert.equal(parsed.uiRecovery!.publications[0]!.actions.length, 3);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.pluginQueries!.publications[0]!.target));
  assert.ok(Object.isFrozen(parsed.uiRecovery!.publications[0]!.actions));
});

test("new execution schema reuses metadata validation without inventing a task mapping", () => {
  const value = {
    version: DESKTOP_PROJECT_EXECUTION_VERSION,
    pluginUi: valid.pluginUi,
  };
  assert.deepEqual(
    parseDesktopProjectExecutionConfiguration(value, options),
    value,
  );
  const onlyGeneration = {
    version: DESKTOP_PROJECT_EXECUTION_VERSION,
    pluginGenerations: valid.pluginGenerations,
  };
  assert.deepEqual(
    parseDesktopProjectExecutionConfiguration(onlyGeneration, options),
    onlyGeneration,
  );
});

test("Native v3 can retain metadata recovery without adding or borrowing any execution mapping", () => {
  const value = {
    version: DESKTOP_PROJECT_EXECUTION_VERSION,
    pluginUi: valid.pluginUi,
    uiRecovery: {
      version: "crewon.plugin-ui-recovery.v1",
      publications: [{ ...source, actions: [] }],
    },
  };
  const parsed = parseDesktopProjectExecutionConfiguration(value, options);
  assert.deepEqual(parsed, value);
  assert.equal(parsed.pluginGenerations, undefined);
  assert.equal(parsed.pluginQueries, undefined);
  for (const changed of [
    { ...value, pluginUi: undefined },
    {
      ...value,
      uiRecovery: {
        ...value.uiRecovery,
        publications: [{ ...source, contributionId: "other", actions: [] }],
      },
    },
    {
      ...value,
      uiRecovery: {
        ...value.uiRecovery,
        publications: [{ ...source, actions: [generate] }],
      },
    },
  ])
    assert.throws(() =>
      parseDesktopProjectExecutionConfiguration(changed, options),
    );
  const metadataSource = { ...source, contributionId: "metadata-only" };
  const mixed = {
    ...valid,
    pluginUi: { publications: [source, metadataSource] },
    uiRecovery: {
      ...valid.uiRecovery,
      publications: [
        ...valid.uiRecovery.publications,
        { ...metadataSource, actions: [] },
      ],
    },
  };
  assert.deepEqual(
    parseDesktopProjectExecutionConfiguration(mixed, options),
    mixed,
  );
});

test("history v1 remains strict and cannot receive the new mapping or recovery authority", () => {
  for (const field of ["pluginGenerations", "pluginQueries"] as const)
    assert.throws(() =>
      parseDesktopProjectHistoryConfiguration(
        {
          version: DESKTOP_PROJECT_HISTORY_VERSION,
          pluginUi: valid.pluginUi,
          [field]: valid[field],
        },
        options,
      ),
    );
  assert.throws(() =>
    parseDesktopProjectHistoryConfiguration(
      {
        version: DESKTOP_PROJECT_HISTORY_VERSION,
        ...Object.fromEntries(
          Object.entries(valid).filter(([key]) => key !== "version"),
        ),
      },
      options,
    ),
  );
});

test("query requires the explicit original generation reader", () => {
  const { generationReads: _reads, ...value } = valid;
  assert.throws(() =>
    parseDesktopProjectExecutionConfiguration(value, options),
  );
  assert.throws(() =>
    parseDesktopProjectExecutionConfiguration(
      {
        version: DESKTOP_PROJECT_EXECUTION_VERSION,
        pluginQueries: valid.pluginQueries,
      },
      options,
    ),
  );
});

test("every recovery action needs its exact independently approved source mapping", () => {
  for (const [action, field] of [
    [generate, "pluginGenerations"],
    [query, "pluginQueries"],
    [select, "selectionUi"],
  ] as const) {
    const input: Record<string, unknown> = structuredClone(valid);
    delete input[field];
    input.uiRecovery = {
      version: "crewon.plugin-ui-recovery.v1",
      publications: [{ ...source, actions: [action] }],
    };
    assert.throws(() =>
      parseDesktopProjectExecutionConfiguration(input, options),
    );
  }
  for (const changed of [
    { ...source, contributionId: "other" },
    { ...source, pluginId: "other.source" },
    { ...source, packageDigest: target.packageDigest },
  ])
    assert.throws(() =>
      parseDesktopProjectExecutionConfiguration(
        {
          ...valid,
          uiRecovery: {
            version: "crewon.plugin-ui-recovery.v1",
            publications: [{ ...changed, actions: [generate] }],
          },
        },
        options,
      ),
    );
});

test("generation and query sources bind the exact public approval while targets remain deployment data", () => {
  for (const field of ["pluginGenerations", "pluginQueries"] as const)
    assert.throws(() =>
      parseDesktopProjectExecutionConfiguration(
        {
          ...valid,
          [field]: {
            publications: [
              {
                ...valid[field].publications[0],
                source: { ...source, packageDigest: target.packageDigest },
              },
            ],
          },
        },
        options,
      ),
    );
  assert.throws(() =>
    parseDesktopProjectExecutionConfiguration(valid, { publications: [] }),
  );
  for (const key of [
    "pluginId",
    "packageDigest",
    "contributionId",
    "action",
  ] as const) {
    const badTarget = { ...target, action: "image.generate", [key]: "" };
    assert.throws(() =>
      parseDesktopProjectExecutionConfiguration(
        {
          ...valid,
          pluginGenerations: { publications: [{ source, target: badTarget }] },
        },
        options,
      ),
    );
  }
});

test("duplicates, unknown actions and hybrid mapping fields refuse", () => {
  for (const value of [
    {
      ...valid,
      pluginGenerations: {
        publications: [
          ...valid.pluginGenerations.publications,
          { source, target: { ...target, action: "other.action" } },
        ],
      },
    },
    { ...valid, pluginGenerations: { publications: [] } },
    {
      ...valid,
      pluginQueries: {
        publications: [
          { ...valid.pluginQueries.publications[0], permissions: ["allow"] },
        ],
      },
    },
    {
      ...valid,
      uiRecovery: {
        ...valid.uiRecovery,
        publications: [{ ...source, actions: [generate, generate] }],
      },
    },
    {
      ...valid,
      uiRecovery: {
        ...valid.uiRecovery,
        publications: [{ ...source, actions: ["image.generate"] }],
      },
    },
    {
      ...valid,
      uiRecovery: {
        ...valid.uiRecovery,
        publications: [
          ...valid.uiRecovery.publications,
          { ...source, actions: [generate] },
        ],
      },
    },
    { version: DESKTOP_PROJECT_EXECUTION_VERSION },
    { ...valid, version: DESKTOP_PROJECT_HISTORY_VERSION },
  ])
    assert.throws(() =>
      parseDesktopProjectExecutionConfiguration(value, options),
    );
});

test("data contract accepts no identity, endpoint, credentials, price or implicit wallet", () => {
  for (const field of [
    "actor",
    "scope",
    "authorization",
    "token",
    "supplier",
    "baseUrl",
    "price",
    "wallet",
    "agentVersionId",
    "activation",
  ])
    assert.throws(() =>
      parseDesktopProjectExecutionConfiguration(
        { ...valid, [field]: "unapproved" },
        options,
      ),
    );
});

test("own-data and encoded bounds reject accessors, sparse/symbol/hidden arrays and cyclic input without invoking hooks", () => {
  let calls = 0;
  const getter = { ...valid };
  Object.defineProperty(getter, "pluginGenerations", {
    enumerable: true,
    get() {
      calls++;
      return valid.pluginGenerations;
    },
  });
  assert.throws(() =>
    parseDesktopProjectExecutionConfiguration(getter, options),
  );
  const sources = { ...options };
  Object.defineProperty(sources, "publications", {
    enumerable: true,
    get() {
      calls++;
      return options.publications;
    },
  });
  assert.throws(() =>
    parseDesktopProjectExecutionConfiguration(valid, sources),
  );
  assert.equal(calls, 0);
  const sparse = new Array(1);
  const symbol = [...valid.pluginGenerations.publications];
  Object.defineProperty(symbol, Symbol("hidden"), { value: true });
  const hidden = [...valid.pluginGenerations.publications];
  Object.defineProperty(hidden, "extra", { value: true });
  for (const publications of [
    sparse,
    symbol,
    hidden,
    new Array(33).fill(valid.pluginGenerations.publications[0]),
  ])
    assert.throws(() =>
      parseDesktopProjectExecutionConfiguration(
        { ...valid, pluginGenerations: { publications } },
        options,
      ),
    );
  const cyclic: Record<string, unknown> = { ...valid };
  cyclic.extra = cyclic;
  assert.throws(() =>
    parseDesktopProjectExecutionConfiguration(cyclic, options),
  );
  assert.throws(() =>
    parseDesktopProjectExecutionConfiguration(
      { ...valid, extra: "x".repeat(64 * 1024) },
      options,
    ),
  );
});

test("execution approvals retain independent text UI declarations without changing original mappings or recovery", () => {
  const input = {
    ...valid,
    textArtifacts: { version: "crewon.project-text.v1" },
    textUi: { publications: [source] },
  };
  const parsed = parseDesktopProjectExecutionConfiguration(input, options);
  assert.deepEqual(parsed, input);
  assert.deepEqual(parsed.pluginGenerations, valid.pluginGenerations);
  assert.deepEqual(parsed.uiRecovery, valid.uiRecovery);
  assert.throws(() =>
    parseDesktopProjectExecutionConfiguration(
      { ...input, textArtifacts: undefined },
      options,
    ),
  );
  assert.deepEqual(
    parseDesktopProjectExecutionConfiguration(valid, options),
    valid,
  );
});
