import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { DeterministicFakeModelTransport } from "@crewon/agent-kernel";
import { sqliteSettlementFixture } from "../../../packages/store/src/sqlite-plugin-credit-settlement.test-support.ts";
import { activateStandaloneRuntimeAgentVersionRelease } from "./agent-version-release-composition.ts";
import { bootstrapProcessFixture } from "./runtime-bootstrap-process.test-support.ts";
import {
  resolveRuntimeBootstrapAgent,
  resolveRuntimeBootstrapRoute,
} from "./runtime-bootstrap-defaults.ts";
import { createConfiguredToolRuntime } from "./runtime-process-environment.ts";

type OriginalMainChild = ReturnType<
  ReturnType<typeof bootstrapProcessFixture>["start"]
>;

export async function waitForFinancialMain(
  condition: () => boolean | Promise<boolean>,
  detail: string,
): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!(await condition())) {
    assert.ok(performance.now() < deadline, detail);
    await delay(10);
  }
}

export async function completeFinancialMain(worker: OriginalMainChild) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      worker.completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `financial_main_process_timeout\n${worker.stdout()}\n${worker.stderr()}`,
              ),
            ),
          10_000,
        );
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Real original Store APIs prepare a named paid v1 admission and terminal mutation facts. This fixture does not claim supplier execution. */
export async function financialMainProcessFixture(t: TestContext) {
  const bootstrap = bootstrapProcessFixture(t);
  const facts = await sqliteSettlementFixture(t);
  await facts.addMutation("completed");
  await facts.addOperation("succeeded");
  await facts.complete();
  const installed = facts.input.pluginAdmission;
  assert.ok(installed);
  const scope = Object.freeze({
    tenantId: installed.tenantId,
    spaceId: installed.spaceId,
    profileId: installed.profileId,
  });
  const environment = Object.freeze({
    ...bootstrap.environment,
    CREWON_TENANT_ID: scope.tenantId,
    CREWON_CONTROL_DB_PATH: facts.databasePath,
    CREWON_WORKER_ONCE: "0",
    CREWON_WORKER_SCAN_INTERVAL_MS: "20",
  });
  const tools = await createConfiguredToolRuntime(environment);
  const agent = resolveRuntimeBootstrapAgent(environment);
  try {
    await activateStandaloneRuntimeAgentVersionRelease({
      databasePath: facts.databasePath,
      runtimeTenantId: scope.tenantId,
      route: resolveRuntimeBootstrapRoute(environment),
      transport: new DeterministicFakeModelTransport({
        expectedLastUserMessage: "fixture",
        events: [],
      }),
      toolRuntime: tools,
      agentInstructions: agent.instructions,
      streamMaxRetries: agent.streamMaxRetries,
      maxToolRounds: agent.maxToolRounds,
      autoCompactAtTokens: agent.autoCompactAtTokens,
      modelContextWindowTokens: agent.contextWindowTokens,
      actor: {
        tenantId: scope.tenantId,
        spaceId: scope.spaceId,
        principalId: "named-financial-main-release-principal",
        actorId: "named-financial-main-release-actor",
      },
      authorization: { authorize: async () => ({ outcome: "allow" }) },
      clock: { now: () => new Date().toISOString() },
      activationId: "named-financial-main-release",
    });
  } finally {
    await tools?.close?.();
  }
  // The release compiler's MCP process must never prove Main's later cleanup.
  rmSync(join(bootstrap.root, "mcp.pid"), { force: true });
  rmSync(bootstrap.closingFile, { force: true });
  const originalEvents = await facts.parent.listRunEvents(
    facts.locator,
    0,
    100,
  );
  const originalAccount = await facts.credits.getAccount(
    facts.admission.reservation.scope,
  );
  const originalLedgerEntries = await facts.count("plugin_credit_entries");
  const originalEvidence = await facts.settlement.loadEvidence(facts.locator);
  assert.ok(originalEvidence?.readyToFinalize);
  assert.equal(originalEvidence.mutationReceipts.length, 1);
  assert.equal(originalEvidence.operations.length, 1);
  assert.equal(originalEvidence.workItems.length, 1);
  const children = new Set<OriginalMainChild>();
  const stop = async (worker: OriginalMainChild) => {
    if (worker.child.exitCode === null && worker.child.signalCode === null)
      worker.child.kill("SIGTERM");
    let result: Awaited<OriginalMainChild["completion"]>;
    try {
      result = await completeFinancialMain(worker);
    } catch (error) {
      if (worker.child.exitCode === null && worker.child.signalCode === null)
        worker.child.kill("SIGKILL");
      await worker.completion;
      children.delete(worker);
      throw error;
    }
    children.delete(worker);
    assert.equal(result.signal, null, worker.stderr());
    assert.equal(result.code, 0, worker.stderr());
    assert.equal(result.mcpGoneAtWorkerExit, true);
    assert.equal(bootstrap.gone(), true);
    return result;
  };
  t.after(async () => {
    for (const worker of children) {
      try {
        await stop(worker);
      } catch (error) {
        if (worker.child.exitCode === null && worker.child.signalCode === null)
          worker.child.kill("SIGKILL");
        await worker.completion;
        throw error;
      }
    }
  });
  return {
    bootstrap,
    facts,
    scope,
    originalEvents,
    originalEvidence,
    originalAccount,
    originalLedgerEntries,
    start(changes: NodeJS.ProcessEnv) {
      rmSync(join(bootstrap.root, "mcp.pid"), { force: true });
      rmSync(bootstrap.closingFile, { force: true });
      const worker = bootstrap.start({ ...environment, ...changes });
      children.add(worker);
      return worker;
    },
    async started(worker: OriginalMainChild) {
      await waitForFinancialMain(
        () => worker.stdout().includes("CrewON Runtime Worker started"),
        `original Main did not start\n${worker.stderr()}`,
      );
      assert.ok(existsSync(join(bootstrap.root, "mcp.pid")));
      assert.equal(bootstrap.gone(), false);
    },
    stop,
  };
}
