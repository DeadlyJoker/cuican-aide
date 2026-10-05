import assert from "node:assert/strict";
import test from "node:test";
import { parseDesktopProjectHistoricalQueriesConfiguration } from "./desktop-project-historical-query-contract.ts";
import { parseDesktopProjectExecutionConfiguration } from "./desktop-project-execution-contract.ts";
import { parseDesktopProjectHistoryConfiguration } from "./desktop-project-history-contract.ts";
import {
  parseProjectHistoricalQueryUiActionRequest,
  parseProjectHistoricalQueryUiActionResponse,
} from "./project-historical-query-ui-action-contract.ts";
const digest = `sha256:${"a".repeat(64)}`;
const source = {
  pluginId: "example.drama",
  packageDigest: digest,
  contributionId: "workbench",
};
const target = {
  pluginId: "example.krea",
  publisherId: "example.publisher",
  version: "1.0.0",
  packageDigest: `sha256:${"b".repeat(64)}`,
  manifestDigest: digest,
  implementationDigest: digest,
  contributionId: "workbench",
  action: "image.query",
};
const options = {
  publications: [
    { pluginId: source.pluginId, packageDigest: source.packageDigest },
  ],
};
const history = {
  version: "crewon.desktop-project-historical-query.v1",
  publications: [{ source, target }],
};
const metadata = {
  pluginUi: { publications: [source] },
  generationReads: { version: "crewon.project-generation-read.v1" },
  generationReadUi: { publications: [source] },
};
test("independent historical query declaration pins every target identity and permits multiple distinct historical packages", () => {
  assert.deepEqual(
    parseDesktopProjectHistoricalQueriesConfiguration(history, options),
    history,
  );
  const second = {
    source,
    target: {
      ...target,
      version: "2.0.0",
      packageDigest: `sha256:${"c".repeat(64)}`,
    },
  };
  assert.equal(
    parseDesktopProjectHistoricalQueriesConfiguration(
      { ...history, publications: [...history.publications, second] },
      options,
    ).publications.length,
    2,
  );
  assert.throws(() =>
    parseDesktopProjectHistoricalQueriesConfiguration(
      {
        ...history,
        publications: [...history.publications, ...history.publications],
      },
      options,
    ),
  );
  for (const patch of [
    { action: "image.generate" },
    { manifestDigest: null },
    { implementationDigest: "unknown" },
    { grant: true },
  ])
    assert.throws(() =>
      parseDesktopProjectHistoricalQueriesConfiguration(
        {
          ...history,
          publications: [{ source, target: { ...target, ...patch } }],
        },
        options,
      ),
    );
  assert.throws(() =>
    parseDesktopProjectHistoricalQueriesConfiguration(history, {
      publications: [],
    }),
  );
});
test("historical query publication requires its exact metadata/read source, while old self-query duplicate rules remain strict", () => {
  const base = {
    version: "crewon.desktop-project-execution.v1",
    ...metadata,
    historicalQueries: history,
  };
  assert.ok(
    parseDesktopProjectExecutionConfiguration(base, options).historicalQueries,
  );
  for (const missing of ["pluginUi", "generationReads", "generationReadUi"]) {
    const copy = { ...base } as Record<string, unknown>;
    delete copy[missing];
    assert.throws(() =>
      parseDesktopProjectExecutionConfiguration(copy, options),
    );
  }
  const oldPublication = {
    source,
    target: { ...source, action: "image.query" },
  };
  assert.throws(() =>
    parseDesktopProjectExecutionConfiguration(
      {
        version: base.version,
        ...metadata,
        pluginQueries: {
          publications: [
            oldPublication,
            {
              ...oldPublication,
              target: { ...oldPublication.target, action: "another.query" },
            },
          ],
        },
      },
      options,
    ),
  );
});
test("planning draft metadata is explicitly opt-in and requires text, conversation and plan publications", () => {
  const base = {
    version: "crewon.desktop-project-history.v1",
    pluginUi: { publications: [source] },
    textArtifacts: { version: "crewon.project-text.v1" },
    textUi: { publications: [source] },
    conversations: { publications: [source] },
    textPlans: { publications: [source] },
  };
  assert.equal(
    Object.hasOwn(
      parseDesktopProjectHistoryConfiguration(base, options),
      "planningDrafts",
    ),
    false,
  );
  const enabled = { ...base, planningDrafts: { publications: [source] } };
  assert.ok(
    parseDesktopProjectHistoryConfiguration(enabled, options).planningDrafts,
  );
  for (const key of ["pluginUi", "textUi", "conversations", "textPlans"]) {
    const copy = { ...enabled } as Record<string, unknown>;
    delete copy[key];
    assert.throws(() => parseDesktopProjectHistoryConfiguration(copy, options));
  }
});
test("new UI query action cannot inherit old namespace and returns only an original Turn receipt", () => {
  const request = {
    action: "crewon.project-historical-queries.v1.queryConceptGeneration",
    input: {
      reference: { projectId: "project", assetId: "asset", assetRevision: 1 },
      operationId: "4263a1da-d6fe-eac4-aaec-f05a1e4f7485",
      threadId: "thread",
      expectedThreadRevision: 1,
      idempotencyKey: "query-existing",
    },
  };
  const parsed = parseProjectHistoricalQueryUiActionRequest(request);
  assert.deepEqual(parsed, request);
  assert.throws(() =>
    parseProjectHistoricalQueryUiActionRequest({
      ...request,
      action: "crewon.project-generation-queries.v1.queryConceptGeneration",
    }),
  );
  assert.throws(() =>
    parseProjectHistoricalQueryUiActionRequest({
      ...request,
      input: { ...request.input, target },
    }),
  );
  const receipt = {
    disposition: "committed",
    threadId: "thread",
    threadRevision: 2,
    runId: "query-run",
    messageId: "query-message",
    configurationRevision: 1,
  };
  assert.deepEqual(
    parseProjectHistoricalQueryUiActionResponse(parsed, receipt),
    receipt,
  );
  assert.throws(() =>
    parseProjectHistoricalQueryUiActionResponse(parsed, {
      ...receipt,
      threadRevision: 3,
    }),
  );
});
