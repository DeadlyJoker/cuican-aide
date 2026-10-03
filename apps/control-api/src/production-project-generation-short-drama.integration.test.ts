import assert from "node:assert/strict";
import test from "node:test";
import { parseGetConceptGenerationResponse } from "@crewon/contracts";
import {
  actor,
  creditScope,
  scope,
} from "./installed-plugin-project-generation-owner.test-support.ts";
import {
  generateAction,
  readinessAction,
  readAction,
  shortDramaGenerationFixture,
} from "./production-project-generation-short-drama.integration.test-support.ts";

const packageDirectory = process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY;
const domModule = process.env.CREWON_HAPPY_DOM_MODULE;

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip:
      !packageDirectory ||
      !domModule ||
      (backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL),
    timeout: 60_000,
  };
  test(
    `${backend} actual short-drama 5.0 ESM saves inputs, generates through the original registered HTTP source/paid Turn/issuer and restores the same Run after close`,
    options,
    async (t) => {
      const f = await shortDramaGenerationFixture(
        t,
        backend,
        packageDirectory!,
        domModule!,
      );
      const before = await f.counts();
      const ui = await f.mount();
      const saved = await f.createSavedInput(ui);
      assert.equal(f.nodeState.quoteCalls, 0);
      assert.equal(f.nodeState.setups, 0);
      assert.deepEqual(
        await f.counts(),
        before,
        "saving metadata and reading readiness create no paid task",
      );
      const ready = f.calls
        .filter((call) => call.action === readinessAction)
        .at(-1)!;
      assert.deepEqual((ready.output as Record<string, unknown>).readiness, {
        outcome: "ready",
      });
      await ui.click(ui.button("生成概念图"));
      await f.wait(
        () =>
          ui.container.querySelector('[aria-label="已保存输入的生成记录"]')
            ?.dataset.runId !== undefined,
      );
      const { request, receipt } = f.latestGeneration();
      assert.equal(receipt.disposition, "committed");
      assert.deepEqual(Object.keys(receipt).sort(), [
        "configurationRevision",
        "disposition",
        "messageId",
        "runId",
        "threadId",
        "threadRevision",
      ]);
      assert.equal(request.expectedThreadRevision, 1);
      assert.equal(receipt.threadRevision, 2);
      assert.equal(
        f.state.lastContext,
        null,
        "only original registered production mount dispatched",
      );
      const submission = f.state.submissions[0]!;
      assert.deepEqual(submission.reference, request.reference);
      assert.equal(submission.sourcePin.pluginId, "crewon.short-drama");
      assert.equal(submission.sourcePin.packageDigest, f.source.packageDigest);
      assert.equal(submission.executionPin.pluginId, scope.pluginId);
      assert.notEqual(
        submission.sourcePin.pluginId,
        submission.executionPin.pluginId,
      );
      assert.deepEqual(submission.command.intent, {
        kind: "generate",
        input: { prompt: saved.prompt },
      });
      assert.doesNotMatch(
        JSON.stringify(request),
        /actor|payer|prompt|tenant|target|crewon\.comfyui/u,
      );
      const locator = {
        projectId: request.reference.projectId,
        assetId: request.reference.assetId,
        assetRevision: request.reference.assetRevision,
      };
      const savedRevision = await f.projectService.getConceptRevision(
        actor,
        locator,
      );
      assert.equal(savedRevision.prompt, saved.prompt);
      assert.equal(savedRevision.briefRevision, 2);
      const brief = await f.projectService.getBrief(actor, {
        projectId: locator.projectId,
        briefRevision: savedRevision.briefRevision,
      });
      assert.equal(brief.text, saved.brief);
      const committed = f.nodeState.accepted[0]!;
      assert.equal(committed.binding.runId, receipt.runId);
      assert.equal(committed.turn.messages[0]!.messageId, receipt.messageId);
      assert.equal(
        committed.binding.configurationRevision,
        receipt.configurationRevision,
      );
      const link = await f.first.store.loadProjectGenerationLink(
        committed.binding,
      );
      assert.ok(link);
      assert.deepEqual(link.reference, request.reference);
      assert.equal(link.assetContentDigest, savedRevision.contentDigest);
      assert.equal(link.briefContentDigest, brief.contentDigest);
      const after = await f.counts(),
        account = await f.credits.getAccount(creditScope);
      for (const table of Object.keys(before))
        assert.equal(after[table], before[table]! + 1, table);
      assert.equal(account?.availableCredits, "70");
      assert.equal(account?.reservedCredits, "30");
      assert.equal(f.nodeState.quoteCalls, 1);
      assert.equal(f.nodeState.setups, 1);
      assert.equal(f.nodeState.calls, 1);
      assert.equal(f.nodeState.disposals, 1);
      const previousMount = ui.lease.mountRef;
      await ui.dispose();
      const cold = await f.mount({
        request,
        phase: "accepted",
        retryable: false,
        receipt,
      });
      assert.notEqual(cold.lease.mountRef, previousMount);
      await f.wait(
        () =>
          cold.container.querySelector('[aria-label="已保存输入的生成记录"]')
            ?.dataset.runId === receipt.runId,
      );
      assert.match(
        cold.container.querySelector('[aria-label="概念图生成"]').textContent,
        /生成任务已受理/u,
      );
      assert.equal(
        f.calls.filter((call) => call.action === generateAction).length,
        1,
        "cold recovery does not generate again",
      );
      const originalRead = f.calls
        .filter((call) => call.action === readAction)
        .at(-1)!;
      assert.deepEqual(originalRead.input, locator);
      const restored = parseGetConceptGenerationResponse(
        originalRead.output,
        locator,
      ).generation;
      assert.ok(restored);
      assert.equal(restored.briefRevision, 2);
      assert.equal(restored.task.runId, receipt.runId);
      assert.equal(restored.task.threadId, receipt.threadId);
      assert.equal(
        restored.task.configurationRevision,
        receipt.configurationRevision,
      );
      assert.equal(restored.task.sourceRunId, null);
      assert.deepEqual(restored.task.operations, []);
      const replay = await f.httpInvoke(
        cold.lease.mountRef,
        generateAction,
        request,
      );
      assert.equal(replay.statusCode, 200, replay.body);
      assert.deepEqual(replay.json().output, {
        ...receipt,
        disposition: "replayed",
      });
      assert.deepEqual(await f.counts(), after);
      assert.deepEqual(await f.credits.getAccount(creditScope), account);
      assert.equal(f.nodeState.quoteCalls, 1);
      assert.equal(await f.count("run_snapshots"), 1);
      assert.equal(await f.count("creative_project_generation_links"), 1);
      assert.ok(f.authority.state.verifiedTlsConnections > 0);
      assert.equal(f.supplierCalls(), 0);
      assert.equal(cold.container.querySelector(".sidebar-account"), null);
      assert.equal(cold.container.querySelector("aside.command-sidebar"), null);
      await cold.dispose();
    },
  );

  test(
    `${backend} actual 5.0 UNKNOWN after a lost committed HTTP response retries the original input and key without another Run, quote or reservation`,
    options,
    async (t) => {
      const f = await shortDramaGenerationFixture(
        t,
        backend,
        packageDirectory!,
        domModule!,
      );
      const ui = await f.mount();
      await f.createSavedInput(ui);
      f.dropAcknowledgement();
      await ui.click(ui.button("生成概念图"));
      await f.wait(() =>
        /生成结果尚未确认/u.test(
          ui.container.querySelector('[aria-label="概念图生成"]')
            ?.textContent ?? "",
        ),
      );
      const original = f.latestGeneration();
      const after = await f.counts(),
        account = await f.credits.getAccount(creditScope);
      assert.equal(f.nodeState.accepted.length, 1);
      assert.equal(ui.button("归档项目").disabled, true);
      assert.equal(ui.button("编辑为新修订").disabled, true);
      ui.update({
        request: original.request,
        phase: "uncertain",
        retryable: true,
        receipt: null,
      });
      await f.wait(() => !ui.button("重试原生成请求").disabled);
      await ui.click(ui.button("重试原生成请求"));
      await f.wait(() =>
        /生成任务已受理/u.test(
          ui.container.querySelector('[aria-label="概念图生成"]')
            ?.textContent ?? "",
        ),
      );
      const retry = f.latestGeneration();
      assert.deepEqual(retry.request, original.request);
      assert.deepEqual(retry.receipt, {
        ...original.receipt,
        disposition: "replayed",
      });
      assert.equal(
        f.calls.filter((call) => call.action === generateAction).length,
        2,
      );
      assert.deepEqual(await f.counts(), after);
      assert.deepEqual(await f.credits.getAccount(creditScope), account);
      assert.equal(f.nodeState.quoteCalls, 1);
      assert.equal(await f.count("run_snapshots"), 1);
      assert.equal(await f.count("plugin_credit_reservations"), 1);
      assert.equal(f.supplierCalls(), 0);
      await ui.dispose();
    },
  );

  for (const withdrawal of ["source-policy", "target-policy"] as const)
    test(
      `${backend} actual 5.0 current ${withdrawal} withdrawal after advisory readiness is rejected before pricing or a paid SQL commit`,
      options,
      async (t) => {
        const f = await shortDramaGenerationFixture(
          t,
          backend,
          packageDirectory!,
          domModule!,
        );
        const ui = await f.mount();
        await f.createSavedInput(ui);
        const before = await f.counts(),
          account = await f.credits.getAccount(creditScope);
        if (withdrawal === "source-policy")
          f.authority.state.policyDenied = true;
        else f.state.targetDenied = true;
        await ui.click(ui.button("生成概念图"));
        await f.wait(() =>
          f.calls.some((call) => call.action === generateAction),
        );
        const refused = f.calls
          .filter((call) => call.action === generateAction)
          .at(-1)!;
        assert.equal(refused.statusCode, 403);
        assert.equal(refused.output, undefined);
        assert.deepEqual(await f.counts(), before);
        assert.deepEqual(await f.credits.getAccount(creditScope), account);
        assert.equal(f.nodeState.quoteCalls, 0);
        assert.equal(f.nodeState.setups, 0);
        assert.equal(f.nodeState.calls, 0);
        assert.equal(f.state.submissions.length, 0);
        assert.equal(f.nodeState.accepted.length, 0);
        assert.equal(f.supplierCalls(), 0);
        await ui.dispose();
      },
    );
}
