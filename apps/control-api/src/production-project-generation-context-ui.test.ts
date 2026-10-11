import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_GENERATION_CONTEXT_UI_ACTIONS } from "@crewon/contracts/plugins";
import { generationContextHttpFixture } from "./production-project-generation-context-ui.test-support.ts";
import {
  actor,
  creditScope,
} from "./installed-plugin-project-generation-owner.test-support.ts";
import { deferred } from "./installed-plugin-task-action-owner.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 30_000,
  };
  test(
    `${backend} original authenticated source HTTP reaches paired readiness owner in real request preparation with no task receipt or payment`,
    options,
    async (t) => {
      const f = await generationContextHttpFixture(t, backend);
      const before = await f.counts(),
        account = await f.credits.getAccount(creditScope);
      const response = await f.invokeHttp();
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.deepEqual(response.json(), {
        output: { reference: f.reference, readiness: { outcome: "ready" } },
      });
      assert.equal(f.preparations(), 1);
      assert.ok(f.authority.state.verifiedTlsConnections > 0);
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(await f.credits.getAccount(creditScope), account);
      assert.equal(f.nodeState.quoteCalls, 0);
      assert.equal(f.nodeState.setups, 0);
      assert.equal(f.nodeState.calls, 0);
    },
  );

  test(
    `${backend} unknown context action and browser-supplied target fields never fall through or prepare execution`,
    options,
    async (t) => {
      const f = await generationContextHttpFixture(t, backend);
      for (const payload of [
        { action: "crewon.project-generation-contexts" },
        {
          action: "crewon.project-generation-contexts.v2.getReadiness",
          input: { reference: f.reference },
        },
        {
          action: "crewon.project-generation-contexts.v1.anyOtherAction",
          input: { reference: f.reference },
        },
        {
          action: PROJECT_GENERATION_CONTEXT_UI_ACTIONS[0],
          input: { reference: f.reference, target: "browser-target" },
        },
      ]) {
        const response = await f.invokeHttp(payload);
        assert.equal(response.statusCode, 400, response.body);
      }
      assert.equal(f.preparations(), 0);
      assert.equal(f.nodeState.calls, 0);
      assert.equal(f.nodeState.quoteCalls, 0);
    },
  );

  test(
    `${backend} optional generation/context declarations preserve actual metadata-only installation without granting either reserved action`,
    options,
    async (t) => {
      const f = await generationContextHttpFixture(t, backend, {
        generationOwner: "disabled",
      });
      const before = await f.counts();
      const listed = await f.invokeHttp({
        action: "crewon.creative-projects.v1.listProjects",
        input: { query: {} },
      });
      assert.equal(listed.statusCode, 200, listed.body);
      assert.equal(
        listed.json().output.projects[0].projectId,
        f.reference.projectId,
      );
      const candidate = {
        descriptor: f.source.descriptor,
        packageDigest: f.source.packageDigest,
      };
      for (const service of [
        "crewon.project-generations",
        "crewon.project-generation-contexts",
      ])
        assert.equal(
          f.metadata!.hostUiServices.isAvailable({
            scope: f.profile,
            candidate,
            requirement: { service, apiVersion: "1", optional: true },
          }),
          false,
        );
      for (const payload of [
        {
          action: PROJECT_GENERATION_CONTEXT_UI_ACTIONS[0],
          input: { reference: f.reference },
        },
        {
          action: "crewon.project-generations.v1.generateConcept",
          input: f.request,
        },
      ]) {
        const response = await f.invokeHttp(payload);
        assert.equal(response.statusCode, 409, response.body);
        assert.equal(
          response.json().error.code,
          "plugin_ui_actions_unavailable",
        );
      }
      assert.equal(f.preparations(), 0);
      assert.deepEqual(await f.counts(), before);
      assert.equal(f.nodeState.quoteCalls, 0);
      assert.equal(f.nodeState.setups, 0);
    },
  );

  for (const change of ["token", "profile", "policy", "close"] as const)
    test(
      `${backend} original HTTP source ${change} withdrawal rejects late plain JSON readiness`,
      options,
      async (t) => {
        const f = await generationContextHttpFixture(t, backend);
        const entered = deferred(),
          release = deferred();
        const original = f.projects.loadProject.bind(f.projects);
        let first = true;
        f.projects.loadProject = async (
          input: Parameters<typeof original>[0],
        ) => {
          const value = await original(input);
          if (first) {
            first = false;
            entered.resolve();
            await release.promise;
          }
          return value;
        };
        const pending = f.invokeHttp();
        await Promise.race([
          entered.promise,
          pending.then((response) => {
            throw new Error(
              `readiness_before_gate:${response.statusCode}:${response.body}`,
            );
          }),
        ]);
        if (change === "token") f.authentication.state.tokenAlive = false;
        if (change === "profile") f.authority.state.changedProfile = true;
        if (change === "policy") f.authority.state.policyDenied = true;
        if (change === "close")
          await f.runtime.service.closeMount(actor, {
            mountRef: f.httpLease.mountRef,
          });
        release.resolve();
        const response = await pending;
        assert.ok([401, 403, 404].includes(response.statusCode), response.body);
        assert.equal(Object.hasOwn(response.json(), "output"), false);
        assert.equal(f.nodeState.quoteCalls, 0);
        assert.equal(f.nodeState.setups, 0);
      },
    );
}
