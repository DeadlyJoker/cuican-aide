import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import * as publicApi from "./index.ts";
import {
  capturePluginProjectCreationScope,
  qualifyPluginProjectCreationScope,
  deriveQualifiedPluginProjectCreationReceipt,
  type PluginProjectCreationScope,
} from "./plugin-project-creation-scope.ts";
import {
  creativeActionFixture,
  creativeCreateInput,
} from "./plugin-creative-project-action.test-support.ts";
import { projectFoundationActionFixture } from "./plugin-project-foundation-action.test-support.ts";
import { createCommand } from "./project-foundation-application-test-support.ts";
import { uiTestActor } from "./plugin-ui.test-support.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";

test("scope issuance is private and detached contexts never become creation sources", () => {
  assert.equal(
    Object.hasOwn(publicApi, "capturePluginProjectCreationScope"),
    false,
  );
  let reads = 0;
  const context = {
    get action() {
      reads++;
      return "crewon.creative-projects.v1.createProject";
    },
  };
  assert.throws(
    () => capturePluginProjectCreationScope(context as PluginUiActionContext),
    /plugin_ui_invocation_unavailable/,
  );
  assert.equal(reads, 0);
  assert.throws(
    () =>
      qualifyPluginProjectCreationScope({
        version: "crewon.plugin-project-creation-scope.v1",
      }),
    /plugin_project_creation_scope_unavailable/,
  );
});

for (const entryPoint of ["creative-project", "project-foundation"] as const) {
  test(`the actual ${entryPoint} creation invocation fixes ownership and loses scope after return`, async (t) => {
    const f =
      entryPoint === "creative-project"
        ? creativeActionFixture()
        : await projectFoundationActionFixture();
    t.after(() => f.owner.close());
    let reference: PluginProjectCreationScope | undefined;
    f.state.afterAction = async (context) => {
      reference = capturePluginProjectCreationScope(context);
      const source = qualifyPluginProjectCreationScope(reference);
      assert.equal(source.entryPoint, entryPoint);
      assert.equal(source.scope.actorId, uiTestActor.actorId);
      assert.equal(source.scope.principalId, uiTestActor.principalId);
      assert.equal(source.scope.profileId, f.ui.state.scope.profileId);
      assert.equal(source.scope.pluginId, f.ui.state.package.pluginId);
      assert.equal(source.scope.publisherId, f.ui.state.package.publisherId);
      const external = {
        idempotencyKey: "same-external-key",
        requestDigest: `sha256:${"a".repeat(64)}`,
      };
      const digester = {
        sha256: (value: string) =>
          `sha256:${createHash("sha256").update(value).digest("hex")}`,
      };
      const receipt = deriveQualifiedPluginProjectCreationReceipt(
        reference,
        external,
        digester,
      );
      assert.deepEqual(receipt.scope, source.scope);
      assert.equal(receipt.entryPoint, entryPoint);
      assert.equal(receipt.externalKey, external.idempotencyKey);
      assert.equal(receipt.receipt.requestDigest, external.requestDigest);
      await source.assertCurrent();
      await source.transaction.assertCurrent();
      source.assertActive();
      for (const copy of [
        { ...reference },
        JSON.parse(JSON.stringify(reference)),
      ])
        assert.throws(
          () => qualifyPluginProjectCreationScope(copy),
          /plugin_project_creation_scope_unavailable/,
        );
      assert.throws(
        () => capturePluginProjectCreationScope({ ...context }),
        /plugin_ui_invocation_unavailable/,
      );
    };
    await f.invoke(
      "createProject",
      entryPoint === "creative-project"
        ? creativeCreateInput()
        : createCommand(),
    );
    assert.ok(reference);
    assert.throws(
      () => qualifyPluginProjectCreationScope(reference!),
      /invocation_unavailable/,
    );
    assert.throws(
      () =>
        deriveQualifiedPluginProjectCreationReceipt(
          reference!,
          {} as never,
          {} as never,
        ),
      /invocation_unavailable/,
    );
  });
}

test("a genuine metadata read invocation cannot qualify creation", async (t) => {
  const f = creativeActionFixture();
  t.after(() => f.owner.close());
  f.state.afterAction = (context) => {
    assert.throws(
      () => capturePluginProjectCreationScope(context),
      /plugin_project_creation_scope_unavailable/,
    );
  };
  await f.invoke("listProjects", { query: { state: "active", limit: 10 } });
});
