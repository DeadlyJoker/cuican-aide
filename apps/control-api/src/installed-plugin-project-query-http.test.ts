import assert from "node:assert/strict";
import test from "node:test";
import { installedProjectQueryHttpFixture } from "./installed-plugin-project-query-http.test-support.ts";
import {
  actor,
  creditScope,
} from "./installed-plugin-project-query-owner.test-support.ts";
import { deferred } from "./installed-plugin-task-action-owner.test-support.ts";
import { createProductionPluginUiRequestService } from "./production-plugin-ui-request-service.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 25_000,
  };
  test(
    `${backend} registered source HTTP uses actual request scope and strict original historical peer recipe before independently installed query B`,
    options,
    async (t) => {
      const f = await installedProjectQueryHttpFixture(t, backend);
      const account = await f.credits.getAccount(creditScope),
        before = await f.counts(),
        quotes = f.nodeState.quoteCalls;
      const accepted = await f.httpInvoke();
      assert.equal(accepted.statusCode, 200, accepted.body);
      const receipt = accepted.json().output;
      assert.equal(receipt.disposition, "committed");
      assert.notEqual(receipt.runId, f.generation.binding.runId);
      assert.equal(receipt.threadId, f.request.threadId);
      const saved = await f.extensions.loadProjectQueryLink({
        tenantId: f.generation.binding.tenantId,
        spaceId: f.generation.binding.spaceId,
        runId: receipt.runId,
      });
      assert.ok(saved);
      assert.equal(saved.executionPin.version, "0.2.0");
      assert.equal(saved.executionPin.packageDigest, f.target.packageDigest);
      assert.equal(saved.sourcePin.pluginId, f.sourceId);
      assert.equal(saved.generationLinkDigest, f.generationLink.contentDigest);
      assert.ok(f.httpState.peerCalls.includes("catalog"));
      assert.ok(f.httpState.peerCalls.includes("queryResolveRegistration"));
      assert.ok(f.httpState.peerCalls.includes("queryReadiness"));
      assert.ok(f.httpState.profileCalls > 1);
      assert.equal(f.nodeState.setups, 1);
      assert.equal(f.nodeState.calls, 1);
      assert.equal(f.nodeState.disposals, 1);
      assert.equal(f.nodeState.quoteCalls, quotes);
      assert.deepEqual(await f.credits.getAccount(creditScope), account);
      const after = await f.counts();
      assert.equal(
        after.creative_project_query_links,
        before.creative_project_query_links! + 1,
      );
      assert.equal(
        after.creative_project_generation_links,
        before.creative_project_generation_links,
      );
      assert.equal(
        after.plugin_credit_reservations,
        before.plugin_credit_reservations,
      );
      const replay = await f.httpInvoke();
      assert.equal(replay.statusCode, 200, replay.body);
      assert.deepEqual(replay.json().output, {
        ...receipt,
        disposition: "replayed",
      });
      assert.deepEqual(await f.counts(), after);
      assert.equal(f.nodeState.quoteCalls, quotes);
      assert.deepEqual(await f.credits.getAccount(creditScope), account);
    },
  );

  test(
    `${backend} current request identity withdrawal during historical peer readiness creates no query or credit mutation`,
    options,
    async (t) => {
      const f = await installedProjectQueryHttpFixture(t, backend);
      const entered = deferred(),
        release = deferred();
      f.httpState.queryEntered = entered.resolve;
      f.httpState.queryGate = release.promise;
      const before = await f.counts(),
        account = await f.credits.getAccount(creditScope);
      const pending = f.httpInvoke();
      await entered.promise;
      f.httpState.identityAllowed = false;
      release.resolve();
      const response = await pending;
      assert.equal(response.statusCode, 403, response.body);
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(await f.credits.getAccount(creditScope), account);
      assert.equal(f.nodeState.disposals, 1);
    },
  );

  test(
    `${backend} unconfigured query family and strict invalid query fields do not prepare the peer or invoke Node`,
    options,
    async (t) => {
      const f = await installedProjectQueryHttpFixture(t, backend);
      const before = await f.counts();
      const disabled = createProductionPluginUiRequestService({
        ui: f.ui.service,
        taskRequests: f.requests,
      });
      assert.throws(
        () =>
          disabled.invokeAuthenticatedRequest!(
            {
              method: "POST",
              url: "/fixture",
              remoteAddress: "127.0.0.1",
              headers: f.headers,
            },
            actor,
            {
              mountRef: f.httpLease.mountRef,
              action:
                "crewon.project-generation-queries.v1.queryConceptGeneration",
              input: f.request,
            },
            new AbortController().signal,
          ),
        /plugin_ui_actions_unavailable/u,
      );
      const injected = await f.app.inject({
        method: "POST",
        url: `/api/v1/plugins/ui/mounts/${f.httpLease.mountRef}/actions`,
        headers: f.headers,
        payload: {
          action: "crewon.project-generation-queries.v1.queryConceptGeneration",
          input: { ...f.request, sourceRunId: f.generation.binding.runId },
        },
      });
      assert.equal(injected.statusCode, 400, injected.body);
      const wrongVersion = await f.httpInvoke(
        f.request,
        "crewon.project-generation-queries.v2.queryConceptGeneration",
      );
      assert.equal(wrongVersion.statusCode, 400, wrongVersion.body);
      assert.equal(f.httpState.peerCalls.length, 0);
      assert.equal(f.nodeState.setups, 0);
      assert.deepEqual(await f.counts(), before);
    },
  );
}
