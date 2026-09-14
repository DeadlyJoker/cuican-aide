import assert from "node:assert/strict";
import test from "node:test";
import type { DomainStore } from "@crewon/application";
import type { ToolExecutionCommand } from "@crewon/tool-broker";
import { startBrowserExecutionTransport } from "../../crewon-ui/electron/browserExecutionTransport.ts";
import { BrowserExecutionToolRuntime } from "./browser-execution-tool-runtime.ts";
import {
  createFixture,
  responseEvents,
} from "./runtime-tool-continuation.test-support.ts";

const START = Date.parse("2026-08-08T01:00:00Z");
const LEASE_MS = 10_000; // Existing Worker fixture duration, never extended.

test("Worker dispatches later model rounds with the renewed authoritative lease after the original deadline", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: START });
  const renewals: Awaited<ReturnType<DomainStore["renewWorkItemLease"]>>[] = [];
  const dispatched: ToolExecutionCommand[] = [];
  const dispatchRenewals: (typeof renewals)[number][] = [];
  const bridge = await startBrowserExecutionTransport({
    async execute(command) {
      const latest = renewals.at(-1)!;
      assert.ok(Date.parse(latest.expiresAt) > Date.now());
      if (dispatched.length === 1) assert.ok(Date.now() > START + LEASE_MS);
      dispatched.push(command);
      dispatchRenewals.push(latest);
      return {
        status: "completed",
        executionId: command.executionId,
        providerReceiptId: `observation:${command.executionId}`,
        result: {
          schemaVersion: "crewon.tool-result.v0",
          callId: command.callId,
          output: '{"targets":[]}',
          isError: false,
          artifactRef: null,
        },
      };
    },
    async reconcile() {
      assert.fail("freshly renewed observe must finish without reconciliation");
    },
    async cancel() {
      assert.fail("renewed observe must not time out");
    },
    async download() {
      assert.fail("observe cannot download");
    },
  });
  context.after(() => bridge.close());
  const fixture = await createFixture(context, {
    backend: "sqlite",
    storeResponses: true,
    crashAfterCommit: false,
    toolRuntimeFactory: (store) => {
      const renew = store.renewWorkItemLease.bind(store);
      store.renewWorkItemLease = async (input) => {
        const lease = await renew(input);
        renewals.push(lease);
        return lease;
      };
      return new BrowserExecutionToolRuntime(bridge);
    },
    beforeUsageRecorded: async () => {
      // Each response fits the current storage lease; the second exceeds the
      // original claim's deadline. Both store and adapter use the same clock.
      fixture.advanceStorageTime(6_000);
      context.mock.timers.tick(6_000);
    },
    modelResponseEvents: (round) =>
      round <= 2
        ? JSON.parse(
            JSON.stringify(
              responseEvents(true, 1, "crewon_browser_observe", "{}"),
            )
              .replaceAll("call-1", `call-round-${round}`)
              .replaceAll("resp-tools", `resp-round-${round}`),
          )
        : responseEvents(false),
  });
  const outcome = await fixture.worker().wake();
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
  assert.equal(dispatched.length, 2);
  assert.equal(fixture.requests.length, 3);
  for (const [index, command] of dispatched.entries()) {
    const authoritative = dispatchRenewals[index]!;
    assert.equal(command.executionLease.expiresAt, authoritative.expiresAt);
    assert.equal(command.executionLease.leaseId, authoritative.leaseId);
    assert.equal(command.executionLease.leaseEpoch, authoritative.epoch);
  }
  assert.equal(
    dispatched[0]!.executionLease.leaseId,
    dispatched[1]!.executionLease.leaseId,
  );
  assert.ok(
    Date.parse(dispatched[1]!.executionLease.expiresAt) >
      Date.parse(dispatched[0]!.executionLease.expiresAt),
  );
  assert.deepEqual(
    (await fixture.receipts()).map((receipt) => receipt?.status),
    ["completed", "completed"],
  );
  assert.equal((await fixture.run())?.status, "completed");
  assert.deepEqual(fixture.retryDelays, []);
});

for (const replacementOwner of [false, true]) {
  test(`Worker refuses browser dispatch when the authoritative lease is lost after preparation (replacement=${replacementOwner})`, async (context) => {
    context.mock.timers.enable({ apis: ["Date"], now: START });
    let invoked = 0;
    let prepared = false;
    let renewalAfterPreparation = false;
    let replacementEpoch: number | undefined;
    const runtime = new BrowserExecutionToolRuntime({
      url: "http://127.0.0.1:1",
      token: "a".repeat(64),
    });
    for (const operation of ["execute", "reconcile", "cancel"] as const) {
      runtime[operation] = async () => {
        invoked++;
        assert.fail("a lost lease must not reach the execution adapter");
      };
    }
    const fixture = await createFixture(context, {
      backend: "sqlite",
      storeResponses: true,
      crashAfterCommit: false,
      toolName: "crewon_browser_observe",
      toolInput: "{}",
      toolRuntimeFactory: (store) => {
        const prepare = store.prepareToolExecution.bind(store);
        store.prepareToolExecution = async (input) => {
          const receipt = await prepare(input);
          prepared = true;
          return receipt;
        };
        const renew = store.renewWorkItemLease.bind(store);
        store.renewWorkItemLease = async (input) => {
          if (prepared) {
            renewalAfterPreparation = true;
            fixture.advanceStorageTime(LEASE_MS);
            context.mock.timers.tick(LEASE_MS);
            if (replacementOwner) {
              const replacement = await store.claimNextWorkItem({
                ownerId: "replacement-worker",
                leaseId: "replacement-lease",
                leaseDurationMs: LEASE_MS,
              });
              assert.ok(replacement);
              replacementEpoch = replacement.lease.epoch;
            }
          }
          return renew(input);
        };
        return runtime;
      },
    });
    await assert.rejects(fixture.worker().wake(), {
      code: replacementOwner ? "stale_lease" : "lease_expired",
    });
    assert.equal(renewalAfterPreparation, true);
    assert.equal(invoked, 0);
    assert.deepEqual(
      (await fixture.receipts()).map((receipt) => receipt?.status),
      ["prepared"],
    );
    assert.equal((await fixture.run())?.status, "running");
    if (replacementOwner) assert.equal(replacementEpoch, 2);
  });
}
