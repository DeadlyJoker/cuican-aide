import assert from "node:assert/strict";
import test from "node:test";
import type {
  CreativeProjectStore,
  ProjectTextStore,
} from "@crewon/application";
import {
  captureProjectConversationConfiguration,
  prepareProjectConversations,
} from "./project-conversation-composition.ts";

const publication = {
  pluginId: "test.conversation",
  packageDigest: `sha256:${"a".repeat(64)}`,
  contributionId: "workbench",
};
test("conversation configuration preserves older approval and captures detached explicit ownership without widening other project grants", () => {
  assert.equal(captureProjectConversationConfiguration(undefined), undefined);
  assert.deepEqual(
    captureProjectConversationConfiguration({ publications: [publication] }),
    { publications: [publication] },
  );
  const input = {
    publications: [{ ...publication }],
    projectOwnership: "plugin-project-v1",
  };
  const actual = captureProjectConversationConfiguration(input)!;
  input.publications[0]!.pluginId = "changed";
  assert.equal(actual.publications[0]!.pluginId, publication.pluginId);
  assert.equal(actual.projectOwnership, "plugin-project-v1");
  assert.ok(Object.isFrozen(actual));
});
test("conversation mode rejects ambiguous, inherited, getter and caller-owner configuration without invoking getters", () => {
  for (const projectOwnership of [
    undefined,
    null,
    true,
    "legacy",
    "plugin-project-v2",
    {},
  ])
    assert.throws(() =>
      captureProjectConversationConfiguration({
        publications: [publication],
        projectOwnership,
      }),
    );
  let reads = 0;
  const accessor = {
    publications: [publication],
    get projectOwnership() {
      reads++;
      return "plugin-project-v1";
    },
  };
  assert.throws(() => captureProjectConversationConfiguration(accessor));
  assert.equal(reads, 0);
  assert.throws(() =>
    captureProjectConversationConfiguration(
      Object.assign(Object.create({ projectOwnership: "plugin-project-v1" }), {
        publications: [publication],
      }),
    ),
  );
  assert.throws(() =>
    captureProjectConversationConfiguration({
      publications: [publication],
      projectOwnership: "plugin-project-v1",
      actor: {},
    }),
  );
});

test("unsupported owned project backend fails before original installation or Conversation migration and never touches a reader getter", async () => {
  let migrations = 0,
    reads = 0;
  const unavailable = () => {
    migrations++;
    throw new Error("migration_must_not_start");
  };
  for (const projects of [
    {},
    {
      get bindProjectReads() {
        reads++;
        return () => {};
      },
    },
  ]) {
    await assert.rejects(
      prepareProjectConversations(
        {
          projectConversationStore: unavailable,
          pluginInstallationStore: unavailable,
          extensionStore: unavailable,
        },
        {
          configuration: {
            publications: [publication],
            projectOwnership: "plugin-project-v1",
          },
          projects: projects as CreativeProjectStore,
          texts: {} as ProjectTextStore,
          authorization: { authorize: async () => ({ outcome: "allow" }) },
        },
      ),
      { message: "plugin_project_read_store_unavailable" },
    );
  }
  assert.equal(migrations, 0);
  assert.equal(reads, 0);
});
