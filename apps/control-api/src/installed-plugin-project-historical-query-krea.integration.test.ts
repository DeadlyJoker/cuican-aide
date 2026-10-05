import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_HISTORICAL_QUERY_UI_ACTIONS,
  parseProjectHistoricalQueryUiActionResponse,
} from "@crewon/contracts/plugins";
import { historicalKreaFixture } from "./installed-plugin-project-historical-query-krea.test-support.ts";
import {
  KREA_OBSERVE,
  KREA_SUBMIT,
} from "../../runtime-worker/src/installed-plugin-krea2.integration.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: current installed Short18 HTTP action queries original frozen Krea1 via actual Worker hosts and Kernel, without another submit or funding`,
    {
      timeout: 90000,
      skip:
        !process.env.CREWON_TEST_KREA_PLUGIN_DIR ||
        !process.env.CREWON_TEST_PROJECT_HISTORY_SHORT_PLUGIN_DIR ||
        (backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL),
    },
    async (t) => {
      const f = await historicalKreaFixture(t, backend),
        wallet = await f.credits.getAccount(f.creditScope),
        quotes = f.controls.quotes;
      assert.equal(f.pkg.installed.descriptor.version, "1.0.0");
      assert.equal(
        f.pkg.installed.packageDigest,
        "sha256:21b09ffe448150a8154ab1fc95c2b3aacac644c53af52513cccb160d6d114cfa",
      );
      const response = await f.invoke();
      assert.equal(
        response.statusCode,
        200,
        response.body + JSON.stringify(f.errors),
      );
      const action = {
          action: PROJECT_HISTORICAL_QUERY_UI_ACTIONS[0],
          input: f.request,
        },
        receipt = parseProjectHistoricalQueryUiActionResponse(
          action,
          response.json().output,
        );
      const binding = await f.extensions.loadExtensionRunBinding({
        ...f.actor,
        runId: receipt.runId,
      });
      assert.ok(binding);
      assert.deepEqual(binding.target, f.original.binding.target);
      assert.equal(
        binding.configurationDigest,
        f.original.binding.configurationDigest,
      );
      assert.equal(binding.source?.runId, f.original.binding.runId);
      const extensions = f.store.extensionStore();
      await extensions.migrateProjectHistoricalQueries();
      const historical =
        await extensions.loadProjectHistoricalQueryLink(binding);
      assert.ok(historical);
      assert.deepEqual(historical.publication, f.publication);
      assert.equal(historical.sourcePin.version, "18.0.0");
      assert.equal(historical.executionPin.version, "1.0.0");
      assert.ok(f.peerCalls.includes("queryResolveRegistration"));
      assert.ok(f.peerCalls.includes("queryReadiness"));
      assert.equal(f.requests.length, 1);
      assert.equal(f.controls.quotes, quotes);
      assert.deepEqual(await f.credits.getAccount(f.creditScope), wallet);
      const worker = await f.openWorker();
      assert.deepEqual(await worker.worker.wake(), {
        kind: "completed",
        runId: receipt.runId,
      });
      assert.equal((await worker.worker.wake()).kind, "idle");
      await f.closeWorker();
      assert.deepEqual(
        f.requests.map((r) => r.method),
        ["POST", "GET"],
      );
      assert.equal(
        f.requests[1]!.target.endpoint.pathname,
        "/history/" + f.operation.operationId,
      );
      assert.equal(f.submissions.length, 1);
      const queryRun = await f.store.loadRunInSpace(binding);
      assert.equal(queryRun?.status, "completed");
      const events = await f.store.listRunEvents(binding, 0, 128);
      const requested = events.filter((e) => e.type === "tool.requested");
      assert.equal(requested.length, 1);
      assert.match(JSON.stringify(requested), new RegExp(KREA_OBSERVE));
      assert.doesNotMatch(JSON.stringify(requested), new RegExp(KREA_SUBMIT));
      const messages = await f.store.listMessages(binding, 0, 128);
      assert.match(messages.at(-1)!.content, /krea-installed\.png/u);
      const operations = await f.operations.listExternalOperations({
        tenantId: f.original.binding.tenantId,
        runId: f.original.binding.runId,
        bindingDigest: f.original.binding.bindingDigest,
        limit: 16,
      });
      assert.equal(operations.operations.length, 1);
      assert.equal(operations.operations[0]!.status, "succeeded");
      const io = structuredClone(
        f.requests.map((r) => ({
          method: r.method,
          path: r.target.endpoint.pathname,
        })),
      );
      const replay = await f.invoke();
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(
        parseProjectHistoricalQueryUiActionResponse(
          action,
          replay.json().output,
        ).runId,
        receipt.runId,
      );
      assert.deepEqual(
        f.requests.map((r) => ({
          method: r.method,
          path: r.target.endpoint.pathname,
        })),
        io,
      );
      assert.equal(f.controls.quotes, quotes);
      assert.deepEqual(await f.credits.getAccount(f.creditScope), wallet);
      assert.equal(await f.count("plugin_task_admissions"), 1);
      assert.equal(await f.count("plugin_query_task_admissions"), 1);
      assert.equal(await f.count("plugin_credit_reservations"), 1);
    },
  );
