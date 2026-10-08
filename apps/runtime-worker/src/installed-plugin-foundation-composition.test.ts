import assert from "node:assert/strict";
import test from "node:test";
import { captureInstalledPluginExecutionConfig } from "./plugins/installed-plugin-runtime-composition.ts";
import type { InstalledPluginProjectFoundationToolsConfig } from "./plugins/installed-plugin-project-foundation-tools.ts";

const original = {
  installRoot: "/fixture/owned/install",
  authorization: {
    authorize: async () => ({
      outcome: "deny" as const,
      reasonCode: "fixture-deny",
    }),
  },
  resolveActor: async () => null,
  authorizePackage: async () => "deny" as const,
};

test("Foundation opt-in captures independent deployment callbacks and preserves an absent old configuration", async () => {
  assert.equal(
    Object.hasOwn(
      captureInstalledPluginExecutionConfig(original),
      "projectFoundationTools",
    ),
    false,
  );
  let calls = 0;
  const config: {
    -readonly [Key in keyof InstalledPluginProjectFoundationToolsConfig]: InstalledPluginProjectFoundationToolsConfig[Key];
  } = {
    version: "crewon.project-foundation-tools.v1",
    createFoundations() {
      throw new Error("fixture_factory_not_called_by_capture");
    },
    authorization: {
      authorize: async () => ({ outcome: "deny", reasonCode: "fixture-deny" }),
    },
    async authorizeService() {
      assert.equal(this, config);
      calls++;
    },
  };
  const captured = captureInstalledPluginExecutionConfig({
    ...original,
    projectFoundationTools: config,
  });
  assert.equal(calls, 0);
  config.authorizeService = async () =>
    assert.fail("changed callback must not run");
  // No real task or permission is asserted. This tests the deployment capture only.
  await captured.projectFoundationTools!.authorizeService(
    {} as never,
    new AbortController().signal,
  );
  assert.equal(calls, 1);
  assert.equal(Object.isFrozen(captured.projectFoundationTools), true);
});

test("Foundation opt-in cannot be supplied by a getter or an old project service grant", () => {
  let getters = 0;
  assert.throws(
    () =>
      captureInstalledPluginExecutionConfig({
        ...original,
        get projectFoundationTools() {
          getters++;
          return {} as InstalledPluginProjectFoundationToolsConfig;
        },
      }),
    /configuration_invalid/u,
  );
  assert.equal(getters, 0);
  assert.throws(
    () =>
      captureInstalledPluginExecutionConfig({
        ...original,
        projectFoundationTools: {
          version: "crewon.project-tools.v1",
          authorization: original.authorization,
        } as unknown as InstalledPluginProjectFoundationToolsConfig,
      }),
    /authority_denied/u,
  );
});
