import assert from "node:assert/strict";
import test from "node:test";
import { prepareCreativeProjects } from "./creative-project-composition.ts";

test("owned metadata configuration rejects unavailable adapter or getter before original project migration", async () => {
  let migrations = 0,
    reads = 0;
  const publication = {
    pluginId: "test.owned",
    packageDigest: `sha256:${"a".repeat(64)}`,
    contributionId: "workbench",
  };
  const absent = {
    migrate: async () => {
      migrations++;
    },
  };
  const accessor = {
    ...absent,
    get loadOwnedCreationReceipt() {
      reads++;
      return () => {};
    },
  };
  for (const store of [absent, accessor]) {
    const owner = {
      creativeProjectStore: () => store,
    } as unknown as Parameters<typeof prepareCreativeProjects>[0];
    await assert.rejects(
      prepareCreativeProjects(owner, {
        authorization: { authorize: async () => ({ outcome: "allow" }) },
        pluginUi: {
          publications: [publication],
          creationOwnership: "plugin-project-v1",
        },
      }),
      { message: "plugin_project_owned_store_unavailable" },
    );
  }
  assert.equal(migrations, 0);
  assert.equal(reads, 0);
});
