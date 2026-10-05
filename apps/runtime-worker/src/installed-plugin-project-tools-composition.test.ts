import assert from "node:assert/strict";
import test from "node:test";
import type { CreativeProjectAuthorizationPort } from "@crewon/application";
import {
  projectTextFixture,
  textActor,
  textOwner,
} from "../../../packages/store/src/project-text-store.test-support.ts";
import {
  captureInstalledPluginProjectToolsConfig,
  prepareInstalledPluginProjectToolsStores,
  type InstalledPluginProjectToolsConfig,
} from "./plugins/installed-plugin-project-tools.ts";
import { captureInstalledPluginExecutionConfig } from "./plugins/installed-plugin-runtime-composition.ts";

test("project-tool composition preserves the original absent capability and captures a separate project PDP", async () => {
  const original = {
    installRoot: "/owned/install",
    authorization: {
      authorize: async () => ({
        outcome: "deny" as const,
        reasonCode: "owned-denial",
      }),
    },
    resolveActor: async () => null,
    authorizePackage: async () => "deny" as const,
  };
  const legacy = captureInstalledPluginExecutionConfig(original);
  assert.equal(Object.hasOwn(legacy, "projectTools"), false);
  const calls: string[] = [];
  const authorization: CreativeProjectAuthorizationPort = {
    async authorize(request) {
      assert.equal(this, authorization);
      calls.push(request.action);
      return { outcome: "deny", reasonCode: "owned-denial" };
    },
  };
  const source: InstalledPluginProjectToolsConfig = {
    version: "crewon.project-tools.v1",
    authorization,
  };
  const captured = captureInstalledPluginExecutionConfig({
    ...original,
    projectTools: source,
  });
  authorization.authorize = async () =>
    assert.fail("replacement authority must not run");
  const decision = await captured.projectTools!.authorization.authorize({
    actor: textActor,
    action: "creativeProject:write",
    resource: {
      kind: "creativeProject",
      tenantId: textActor.tenantId,
      spaceId: textActor.spaceId,
      projectId: "project",
    },
  });
  assert.deepEqual(decision, { outcome: "deny", reasonCode: "owned-denial" });
  assert.deepEqual(calls, ["creativeProject:write"]);
  assert.equal(Object.isFrozen(captured.projectTools), true);
});
test("malformed project service deployment is rejected without evaluating authority accessors", () => {
  let getters = 0;
  const good = {
    version: "crewon.project-tools.v1",
    authorization: { authorize: async () => ({ outcome: "allow" }) },
  };
  const bad: unknown[] = [
    null,
    { ...good, version: "2" },
    { ...good, actor: textActor },
    { ...good, authorization: {} },
    Object.assign(Object.create(good), {}),
  ];
  for (const key of ["version", "authorization"])
    bad.push(
      Object.defineProperty({ ...good }, key, {
        enumerable: true,
        get() {
          getters++;
          throw new Error("must remain unread");
        },
      }),
    );
  bad.push({
    ...good,
    authorization: Object.defineProperty({}, "authorize", {
      enumerable: true,
      get() {
        getters++;
        throw new Error("must remain unread");
      },
    }),
  });
  for (const value of bad)
    assert.throws(
      () =>
        captureInstalledPluginProjectToolsConfig(
          value as InstalledPluginProjectToolsConfig,
        ),
      /installed_plugin_project_tools_configuration_invalid/u,
    );
  assert.equal(getters, 0);
});
for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend} explicit project deployment migrates only its real parent stores`,
    {
      skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
      timeout: 20_000,
    },
    async (t) => {
      const f = await projectTextFixture(t, backend, false);
      await prepareInstalledPluginProjectToolsStores({
        store: f.first.parent,
        config: undefined,
      });
      await assert.rejects(
        f.first.text.loadOutline({
          owner: textOwner(),
          projectId: f.created.project.projectId,
        }),
      );
      let decisions = 0;
      await prepareInstalledPluginProjectToolsStores({
        store: f.first.parent,
        config: {
          version: "crewon.project-tools.v1",
          authorization: {
            async authorize() {
              decisions++;
              return { outcome: "deny", reasonCode: "owned-denial" };
            },
          },
        },
      });
      assert.equal(
        decisions,
        0,
        "startup is not permission to read or write a project",
      );
      assert.equal(await f.count("project_text_artifacts"), 0);
      assert.equal(await f.count("project_text_revisions"), 0);
      assert.equal(await f.count("project_text_mutation_receipts"), 0);
      assert.equal(
        (
          await f.sql(
            `SELECT version FROM ${f.prefix}project_text_schema_version`,
          )
        )[0]?.version,
        1,
      );
    },
  );
