import assert from "node:assert/strict";
import { test } from "node:test";
import {
  installedProjectHistoricalQueryFixture,
  actor,
  creditScope,
  queryAction,
} from "./installed-plugin-project-historical-query-owner.test-support.ts";
import { installedProjectHistoricalQueryHttpFixture } from "./installed-plugin-project-historical-query-http.test-support.ts";
import { parseProjectHistoricalQueryUiActionResponse } from "@crewon/contracts/plugins";
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 30000,
  };
  test(
    `${backend} installed current source18 retains original target, config, Run and funding through real Node query`,
    options,
    async (t) => {
      const f = await installedProjectHistoricalQueryFixture(t, backend),
        wallet = await f.credits.getAccount(creditScope),
        before = await f.counts(),
        quoteCalls = f.nodeState.quoteCalls;
      const result = parseProjectHistoricalQueryUiActionResponse(
          { action: queryAction, input: f.request },
          await f.invoke(),
        ),
        accepted = f.state.accepted[0];
      assert.ok(accepted);
      assert.equal(result.runId, accepted.binding.runId);
      assert.equal(
        f.state.submissions[0]?.publication.target.version,
        f.oldPin.version,
      );
      assert.equal(
        f.state.submissions[0]?.executionPin.packageDigest,
        f.oldPin.packageDigest,
      );
      assert.deepEqual(accepted.binding.target, f.generation.binding.target);
      assert.equal(
        accepted.binding.configurationDigest,
        f.generation.binding.configurationDigest,
      );
      assert.deepEqual(accepted.binding.source, {
        runId: f.generation.binding.runId,
        bindingDigest: f.generation.binding.bindingDigest,
        operationId: f.operationId,
      });
      const link = await f.extensions.loadProjectHistoricalQueryLink(
        accepted.binding,
      );
      assert.ok(link);
      assert.equal(link.sourcePin.version, "18.0.0");
      assert.deepEqual(link.publication, f.publication);
      const after = await f.counts();
      assert.equal(
        after.creative_project_historical_query_links,
        before.creative_project_historical_query_links! + 1,
      );
      assert.equal(after.plugin_task_admissions, before.plugin_task_admissions);
      assert.deepEqual(await f.credits.getAccount(creditScope), wallet);
      assert.equal(f.nodeState.quoteCalls, quoteCalls);
      assert.equal(f.nodeState.calls, 1);
      assert.equal(f.nodeState.disposals, 1);
      const replay = parseProjectHistoricalQueryUiActionResponse(
        { action: queryAction, input: f.request },
        await f.invoke(),
      );
      assert.equal(replay.runId, result.runId);
      assert.deepEqual(await f.counts(), after);
      await f.owner.close();
      assert.equal(f.nodeState.calls, f.nodeState.disposals);
    },
  );
  test(
    `${backend} current source or exact original target withdrawal denies fresh and saved-key query`,
    options,
    async (t) => {
      const f = await installedProjectHistoricalQueryFixture(t, backend);
      await f.invoke();
      const before = await f.counts();
      await f.disable("target");
      await assert.rejects(f.invoke());
      assert.deepEqual(await f.counts(), before);
      await f.service.closeMount(actor, { mountRef: f.lease.mountRef });
    },
  );
  test(
    `${backend} original authenticated HTTP route admits only new namespace and same original key`,
    options,
    async (t) => {
      const f = await installedProjectHistoricalQueryHttpFixture(t, backend),
        wallet = await f.credits.getAccount(creditScope);
      const response = await f.httpInvoke();
      assert.equal(response.statusCode, 200, response.body);
      const output = parseProjectHistoricalQueryUiActionResponse(
        { action: queryAction, input: f.request },
        response.json().output,
      );
      const replay = await f.httpInvoke();
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(
        parseProjectHistoricalQueryUiActionResponse(
          { action: queryAction, input: f.request },
          replay.json().output,
        ).runId,
        output.runId,
      );
      assert.deepEqual(await f.credits.getAccount(creditScope), wallet);
      assert.equal(
        (
          await f.extensions.loadPluginQueryTaskAdmission({
            ...actor,
            runId: output.runId,
          })
        )?.source.runId,
        f.generation.binding.runId,
      );
      assert.ok(f.httpState.peerCalls.includes("queryResolveRegistration"));
      assert.ok(f.httpState.peerCalls.includes("queryReadiness"));
      const old = await f.httpInvoke(
        f.request,
        "crewon.project-generation-queries.v1.queryConceptGeneration",
      );
      assert.equal(old.statusCode, 409);
      f.httpState.identityAllowed = false;
      const denied = await f.httpInvoke();
      assert.equal(denied.statusCode, 403);
      assert.equal(await f.count("creative_project_historical_query_links"), 1);
    },
  );
}
