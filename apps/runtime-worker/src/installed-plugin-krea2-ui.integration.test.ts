import assert from "node:assert/strict";
import test from "node:test";
import {
  actor,
  scope,
} from "./installed-plugin-business-execution.integration.test-support.ts";
import {
  KREA_OBSERVE,
  KREA_SUBMIT,
  kreaPrompt,
} from "./installed-plugin-krea2.integration.test-support.ts";
import {
  kreaUiFixture,
  kreaUiReceipt,
} from "./installed-plugin-krea2-ui.integration.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    timeout: 60_000,
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  for (const mode of ["replay", "disable", "upgrade"] as const)
    test(
      `${backend}: actual Krea2 UI tasks v2 query ${mode === "disable" ? "survives disable and cold Worker" : mode === "upgrade" ? "pins old A from a real upgraded B UI" : "replays its committed receipt"} without another credit hold or POST`,
      options,
      async (t) => {
        const f = await kreaUiFixture(t, backend);
        const original = await f.generate();
        assert.equal(
          original.lease.packageDigest,
          f.pkg.installed.packageDigest,
        );
        assert.equal(f.ui.identity.packageDigest, original.lease.packageDigest);
        assert.ok(
          f.ui.requests.some((path) =>
            path.includes(
              `/assets/${original.lease.descriptor.entrypoints.ui!.path}`,
            ),
          ),
        );
        assert.equal(
          f.ui.root
            .querySelector("[data-independent-plugin-version]")
            ?.getAttribute("data-independent-plugin-version"),
          "1.0.0",
        );
        const admission = await f.extensions.loadPluginTaskAdmission({
          ...actor,
          runId: original.accepted.runId,
        });
        assert.ok(admission);
        assert.equal(admission.packageDigest, original.lease.packageDigest);
        assert.equal(admission.action, "image.generate");
        assert.equal(admission.profileId, scope.profileId);
        assert.equal(admission.authorityEpoch, f.ui.epoch.value);
        const paid = await f.extensions.loadExtensionCreditAdmission(
          original.projection.binding,
        );
        assert.equal(paid?.reservation.scope.principalId, actor.principalId);
        assert.equal(paid?.reservation.quotedCredits, "30");
        const graph = f.submissions[0]!.prompt;
        assert.equal(graph["29"]!.class_type, "SaveImage");
        assert.equal(
          graph["29"]!.inputs.filename_prefix,
          "crewon-" + original.operation.operationId,
        );
        assert.equal(graph["51"]!.inputs.text, kreaPrompt);
        assert.equal(graph["49"]!.inputs.megapixels, 1);
        const balance = await f.credits.getAccount(f.creditScope);
        const data = await f.queryProjection(
          original.accepted.runId,
          original.operation.operationId,
        );
        const queryPackageDigest =
          mode === "upgrade"
            ? (await f.upgradeUi(data)).registration.identity.packageDigest
            : original.lease.packageDigest;
        if (mode !== "upgrade") await f.ui.update(data);
        assert.equal(
          f.ui.root
            .querySelector("[data-independent-plugin-version]")
            ?.getAttribute("data-independent-plugin-version"),
          mode === "upgrade" ? "2.0.0" : "1.0.0",
        );
        assert.equal(f.ui.identity.packageDigest, queryPackageDigest);
        assert.ok(
          f.ui.root
            .querySelector('[data-role="query-source"]')!
            .textContent.includes(original.operation.operationId),
        );
        // Real UI calls the Node action and tasks@2. An HTTP reply loss must replay the same query commit.
        if (mode === "replay") {
          f.ui.loseNextTaskResponse();
          await assert.rejects(f.ui.click('[data-action="image.query"]'));
          assert.match(
            f.ui.root.querySelector("output")!.textContent,
            /任务未确认受理/u,
          );
        }
        const query = kreaUiReceipt(
          await f.ui.click('[data-action="image.query"]'),
        );
        assert.equal(
          query.disposition,
          mode === "replay" ? "replayed" : "committed",
        );
        if (mode === "replay")
          assert.deepEqual(
            { ...query, disposition: "committed" },
            kreaUiReceipt(f.ui.committedResponses[1]!),
          );
        assert.notEqual(query.runId, original.accepted.runId);
        assert.equal(query.threadId, data.threadId);
        assert.equal(await f.count("run_snapshots"), 2);
        assert.equal(await f.count("plugin_task_admissions"), 1);
        assert.equal(await f.count("plugin_query_task_admissions"), 1);
        assert.equal(await f.count("plugin_credit_reservations"), 1);
        assert.equal(f.controls.quotes, 1);
        assert.deepEqual(await f.credits.getAccount(f.creditScope), balance);
        const binding = await f.extensions.loadExtensionRunBinding({
          ...actor,
          runId: query.runId,
        });
        assert.ok(binding);
        assert.deepEqual(binding.source, {
          runId: original.accepted.runId,
          bindingDigest: original.projection.binding.bindingDigest,
          operationId: original.operation.operationId,
        });
        assert.deepEqual(binding.target, original.projection.binding.target);
        assert.equal(
          await f.extensions.loadExtensionCreditAdmission(binding),
          null,
        );
        const queryAdmission =
          await f.extensions.loadPluginQueryTaskAdmission(binding);
        assert.ok(queryAdmission);
        assert.equal(queryAdmission.action, "image.query");
        assert.equal(queryAdmission.packageDigest, queryPackageDigest);
        assert.deepEqual(queryAdmission.source, admission);
        assert.deepEqual(
          f.requests.map((request) => request.method),
          ["POST"],
        );
        if (mode === "disable") {
          await f.ui.stop();
          await f.select("disabled");
          await assert.rejects(f.ui.mount(data));
        }
        const actionDigests: string[] = [];
        const worker = await f.openWorker({
          afterToolReceiptCommitted: async (receipt) => {
            actionDigests.push(receipt.actionDigest);
          },
        });
        assert.deepEqual(await worker.worker.wake(), {
          kind: "completed",
          runId: query.runId,
        });
        assert.equal((await worker.worker.wake()).kind, "idle");
        assert.deepEqual(
          f.requests.map((request) => request.method),
          ["POST", "GET"],
        );
        assert.equal(
          f.requests[1]!.target.endpoint.pathname,
          "/history/" + original.operation.operationId,
        );
        assert.equal(f.submissions.length, 1);
        const projection = await f.reads.getTask(actor, {
          pluginId: admission.pluginId,
          runId: query.runId,
        });
        assert.equal(projection.run.status, "completed");
        assert.equal(
          projection.configuration.contentDigest,
          original.projection.configuration.contentDigest,
        );
        assert.equal(projection.operations[0]!.runId, original.accepted.runId);
        assert.equal(projection.operations[0]!.status, "succeeded");
        const result = JSON.parse(projection.operations[0]!.resultJson!);
        assert.equal(result.images[0].filename, "krea-installed.png");
        const events = await f.store.listRunEvents(binding, 0, 128);
        const requested = events.filter(
          (event) => event.type === "tool.requested",
        );
        assert.equal(requested.length, 1);
        assert.match(JSON.stringify(requested), new RegExp(KREA_OBSERVE));
        assert.doesNotMatch(JSON.stringify(requested), new RegExp(KREA_SUBMIT));
        const completed = events.find(
          (event) => event.type === "tool.completed",
        );
        assert.ok(completed?.type === "tool.completed");
        const receipt = await f.store.loadToolExecutionReceiptByAction({
          tenantId: actor.tenantId,
          runId: query.runId,
          actionDigest: actionDigests[0]!,
        });
        assert.equal(receipt?.actionIntent?.effect, "readOnly");
        assert.equal(receipt?.actionIntent?.approvalRequirement, "none");
        assert.equal(
          receipt?.providerReceiptId,
          original.operation.operationId,
        );
        const messages = await f.store.listMessages(binding, 0, 128);
        assert.match(
          messages.at(-1)!.content,
          /图片已生成：https:\/\/krea-fixture\.example\/view\?/u,
        );
        assert.ok(
          f.contexts.some(
            (context) =>
              context.run.runId === query.runId &&
              context.identity.packageDigest === original.lease.packageDigest &&
              context.run.source?.runId === original.accepted.runId,
          ),
        );
        assert.deepEqual(await f.credits.getAccount(f.creditScope), balance);
        assert.equal(f.controls.quotes, 1);
        await f.closeWorker();
        await f.ui.close();
      },
    );
}
