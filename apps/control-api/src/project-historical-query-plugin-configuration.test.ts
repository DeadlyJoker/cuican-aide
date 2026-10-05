import assert from "node:assert/strict";
import test from "node:test";
import {
  captureProjectHistoricalQueryPluginConfiguration,
  assertProjectHistoricalQueryPluginPublications,
} from "./project-historical-query-plugin-configuration.ts";
import { captureProjectQueryPluginConfiguration } from "./project-query-plugin-configuration.ts";
import { captureCreativeProjectCompositionConfig } from "./creative-project-composition.ts";
const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const source = {
  pluginId: "crewon.short-drama",
  packageDigest: digest("a"),
  contributionId: "workbench",
};
const target = {
  pluginId: "crewon.comfyui-krea2",
  publisherId: "crewon",
  version: "1.0.0",
  packageDigest: digest("b"),
  manifestDigest: digest("c"),
  implementationDigest: digest("d"),
  contributionId: "studio",
  action: "image.query",
};
const publication = { source, target };
test("independent historical opt-in captures exact full targets and supports multiple original versions without changing old duplicate policy", () => {
  const second = {
    source,
    target: { ...target, version: "2.0.0", packageDigest: digest("e") },
  };
  const config = captureProjectHistoricalQueryPluginConfiguration({
    version: "crewon.desktop-project-historical-query.v1",
    publications: [publication, second],
  });
  assert.ok(config);
  assert.equal(config.publications.length, 2);
  assert.ok(Object.isFrozen(config.publications[0]!.target));
  assertProjectHistoricalQueryPluginPublications(config, [source]);
  assert.throws(() =>
    captureProjectHistoricalQueryPluginConfiguration({
      version: config.version,
      publications: [publication, publication],
    }),
  );
  assert.throws(
    () =>
      captureProjectQueryPluginConfiguration({
        publications: [
          {
            source,
            target: {
              pluginId: target.pluginId,
              packageDigest: target.packageDigest,
              contributionId: target.contributionId,
              action: target.action,
            },
          },
          {
            source,
            target: {
              pluginId: target.pluginId,
              packageDigest: digest("e"),
              contributionId: target.contributionId,
              action: target.action,
            },
          },
        ],
      }),
    /project_query_publication_source_duplicate/u,
  );
});
test("history requires explicitly approved current source and generation-read opt-in; an accessor is not executed", () => {
  assert.equal(
    captureProjectHistoricalQueryPluginConfiguration(undefined),
    undefined,
  );
  const config = captureProjectHistoricalQueryPluginConfiguration({
    version: "crewon.desktop-project-historical-query.v1",
    publications: [publication],
  });
  assert.ok(config);
  assert.throws(
    () => assertProjectHistoricalQueryPluginPublications(config, []),
    /project_historical_query_source_publication_unapproved/u,
  );
  let calls = 0;
  assert.throws(() =>
    captureProjectHistoricalQueryPluginConfiguration({
      version: config.version,
      get publications() {
        calls++;
        return [publication];
      },
    }),
  );
  assert.equal(calls, 0);
  const authorization = {
    authorize: async () => ({ outcome: "allow" as const }),
  };
  assert.throws(
    () =>
      captureCreativeProjectCompositionConfig({
        authorization,
        historicalQueries: config,
      }),
    /project_query_generation_reader_required/u,
  );
  const prepared = captureCreativeProjectCompositionConfig({
    authorization,
    historicalQueries: config,
    generationReads: { version: "crewon.project-generation-read.v1" },
  });
  assert.deepEqual(prepared?.historicalQueries, config);
});
