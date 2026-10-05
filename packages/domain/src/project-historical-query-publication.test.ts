import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captureProjectHistoricalQueryPublications,
  parseProjectHistoricalQueryPublication,
  assertProjectHistoricalQueryExecutionPublication,
} from "./project-historical-query-publication.ts";
import { captureProjectQueryPublications } from "./project-query-publication.ts";
import type { PluginTaskAdmissionPin } from "./plugin-task-admission.ts";
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const taskPin: PluginTaskAdmissionPin = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  actorId: "actor-1",
  principalId: "principal-1",
  profileId: "profile-1",
  pluginId: "example.video",
  publisherId: "example.publisher",
  version: "1.0.0",
  packageDigest: digest("1"),
  selectionRevision: 2,
  contributionId: "workbench",
  action: "generate",
  authorityEpoch: "epoch-1",
};
const publication = {
  source: {
    pluginId: "example.story",
    packageDigest: digest("a"),
    contributionId: "workbench",
  },
  target: {
    pluginId: "crewon.comfyui-krea2",
    publisherId: "crewon",
    version: "1.0.0",
    packageDigest: digest("b"),
    manifestDigest: digest("c"),
    implementationDigest: digest("d"),
    contributionId: "studio",
    action: "image.query",
  },
};
test("new approval permits multiple exact targets for one source; old query duplicate remains strict", () => {
  const second = {
    ...publication,
    target: {
      ...publication.target,
      version: "2.0.0",
      packageDigest: digest("e"),
    },
  };
  assert.equal(
    captureProjectHistoricalQueryPublications([publication, second]).length,
    2,
  );
  assert.throws(
    () => captureProjectHistoricalQueryPublications([publication, publication]),
    /duplicate/u,
  );
  const old = {
    source: publication.source,
    target: {
      pluginId: publication.target.pluginId,
      packageDigest: publication.target.packageDigest,
      contributionId: publication.target.contributionId,
      action: publication.target.action,
    },
  };
  assert.throws(
    () =>
      captureProjectQueryPublications([
        old,
        { ...old, target: { ...old.target, packageDigest: digest("e") } },
      ]),
    /source_duplicate/u,
  );
});
test("only query action and exact detached fields; getters never run", () => {
  let reads = 0;
  assert.throws(() =>
    parseProjectHistoricalQueryPublication({
      ...publication,
      get target() {
        reads++;
        return publication.target;
      },
    }),
  );
  assert.equal(reads, 0);
  for (const bad of [
    {
      ...publication,
      target: { ...publication.target, action: "image.generate" },
    },
    {
      ...publication,
      target: { ...publication.target, configurationRevision: 1 },
    },
    {
      ...publication,
      target: { ...publication.target, publisherId: "bad publisher" },
    },
  ])
    assert.throws(() => parseProjectHistoricalQueryPublication(bad));
});
test("current new UI and historical execution retain distinct exact actor/profile/package identities", () => {
  const p = parseProjectHistoricalQueryPublication(publication),
    sourcePin = {
      ...taskPin,
      ...p.source,
      publisherId: "example.publisher",
      version: "18.0.0",
      action: "crewon.project-historical-queries.v1.queryConceptGeneration",
    },
    executionPin = { ...taskPin, ...p.target };
  const { manifestDigest, implementationDigest, ...pin } = executionPin;
  assertProjectHistoricalQueryExecutionPublication({
    publication: p,
    sourcePin,
    executionPin: pin,
  });
  for (const changed of [
    { ...pin, actorId: "another" },
    { ...pin, profileId: "another" },
    { ...pin, publisherId: "another" },
    { ...pin, version: "2.0.0" },
  ])
    assert.throws(() =>
      assertProjectHistoricalQueryExecutionPublication({
        publication: p,
        sourcePin,
        executionPin: changed,
      }),
    );
  assert.throws(() =>
    assertProjectHistoricalQueryExecutionPublication({
      publication: p,
      sourcePin: {
        ...sourcePin,
        action: "crewon.project-generation-queries.v1.queryConceptGeneration",
      },
      executionPin: pin,
    }),
  );
});
