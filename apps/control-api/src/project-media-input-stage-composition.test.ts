import assert from "node:assert/strict";
import test from "node:test";
import {
  captureCreativeProjectCompositionConfig,
  prepareCreativeProjects,
} from "./creative-project-composition.ts";
import { conversationFixture } from "../../../packages/store/src/project-conversation-store.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
const publications = [
  {
    pluginId: "crewon.short-drama",
    packageDigest: `sha256:${"a".repeat(64)}`,
    contributionId: "workbench",
  },
];
const configuration = {
  authorization: { authorize: async () => ({ outcome: "allow" as const }) },
  textArtifacts: { version: "crewon.project-text.v1" as const },
  conversations: { publications },
  mediaInputStages: {
    version: "crewon.project-media-input-stages.v1" as const,
    publications,
  },
};
test("media stage deployment is independent, immutable and rejects mismatched conversation publications/accessors", () => {
  const old = {
    authorization: configuration.authorization,
    textArtifacts: configuration.textArtifacts,
    conversations: configuration.conversations,
  };
  assert.equal(
    captureCreativeProjectCompositionConfig(old)?.mediaInputStages,
    undefined,
  );
  const captured = captureCreativeProjectCompositionConfig(configuration)!;
  assert.deepEqual(captured.mediaInputStages, configuration.mediaInputStages);
  assert.ok(Object.isFrozen(captured.mediaInputStages));
  assert.ok(Object.isFrozen(captured.mediaInputStages.publications));
  for (const raw of [
    { ...configuration, conversations: undefined },
    {
      ...configuration,
      mediaInputStages: { ...configuration.mediaInputStages, version: "v2" },
    },
    {
      ...configuration,
      mediaInputStages: {
        ...configuration.mediaInputStages,
        publications: [
          { ...publications[0], packageDigest: `sha256:${"b".repeat(64)}` },
        ],
      },
    },
  ])
    assert.throws(() => captureCreativeProjectCompositionConfig(raw));
  let reads = 0;
  assert.throws(() =>
    captureCreativeProjectCompositionConfig(
      Object.defineProperty({ ...configuration }, "mediaInputStages", {
        enumerable: true,
        get() {
          reads++;
          return configuration.mediaInputStages;
        },
      }),
    ),
  );
  assert.equal(reads, 0);
});
for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: explicit media stage composition borrows the actual parent and disabled composition never obtains its adapter`,
    assetTestOptions(backend),
    async (t) => {
      const f = await conversationFixture(t, backend);
      let acquired = 0;
      const original = f.parent.projectMediaInputStageStore.bind(f.parent);
      t.mock.method(f.parent, "projectMediaInputStageStore", () => {
        acquired++;
        return original();
      });
      const base = await prepareCreativeProjects(
        f.parent,
        captureCreativeProjectCompositionConfig({
          authorization: configuration.authorization,
          textArtifacts: configuration.textArtifacts,
          conversations: configuration.conversations,
        }),
      );
      assert.equal(base?.mediaInputStageFoundation, undefined);
      assert.equal(acquired, 0);
      const prepared = await prepareCreativeProjects(
        f.parent,
        captureCreativeProjectCompositionConfig(configuration),
      );
      assert.ok(prepared?.mediaInputStageFoundation);
      assert.equal(acquired, 1);
      const stages = prepared.mediaInputStageFoundation.store;
      assert.equal(
        stages.version,
        "crewon.project-media-input-stage-run-admission.v1",
      );
      assert.equal(
        await stages.loadMediaInputStageAdmission({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          runId: "not-an-admitted-run",
        }),
        null,
      );
    },
  );
