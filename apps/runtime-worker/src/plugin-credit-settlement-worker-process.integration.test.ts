import assert from "node:assert/strict";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { bootstrapProcessFixture } from "./runtime-bootstrap-process.test-support.ts";
import { createPluginCreditSettlementWorkerHttpFixture } from "./plugin-credit-settlement-worker-http.test-support.ts";
import {
  completeFinancialMain,
  financialMainProcessFixture,
  waitForFinancialMain,
} from "./plugin-credit-settlement-worker-main-process.test-support.ts";
import { PLUGIN_CREDIT_SETTLEMENT_WORKER_CONFIG_ENV } from "./plugins/plugin-credit-settlement-worker-config.ts";

async function financialHttps(
  t: TestContext,
  directory: string,
  tenantId = "standalone-tenant",
) {
  const fixture = await createPluginCreditSettlementWorkerHttpFixture({
    directory,
    scope: {
      tenantId,
      spaceId: "financial-process-test-space",
      profileId: "financial-process-test-profile",
    },
  });
  t.after(() => fixture.close());
  return fixture;
}
function assertTokenRedacted(
  stderr: string,
  environment: Readonly<NodeJS.ProcessEnv>,
) {
  for (const [name, value] of Object.entries(environment)) {
    if (name.endsWith("_TOKEN"))
      assert.ok(
        value !== undefined && !stderr.includes(value),
        "financial_token_exposed_in_worker_output",
      );
  }
}

function financialTables(path: string): string[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare(
        "SELECT name FROM main.sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name))
      .filter(
        (name) =>
          name.startsWith("plugin_credit_") ||
          name.startsWith("extension_credit_"),
      );
  } finally {
    database.close();
  }
}

test(
  "actual Worker main without financial opt-in preserves the original release and physically closes its own MCP child",
  { timeout: 15_000 },
  async (t) => {
    const f = bootstrapProcessFixture(t);
    const https = await financialHttps(t, f.root);
    const configPath = join(f.root, "financial.json");
    writeFileSync(configPath, JSON.stringify(https.configuration()), {
      mode: 0o600,
    });
    await f.activate();
    // Activation has its own MCP process. Its stale pid must not prove Worker cleanup.
    rmSync(join(f.root, "mcp.pid"), { force: true });
    const before = financialTables(join(f.root, "control.sqlite"));
    assert.deepEqual(before, []);
    const worker = f.start({
      ...https.environment,
    });
    const result = await worker.completion;
    assert.equal(result.code, 0, worker.stderr());
    assert.equal(result.signal, null);
    assert.deepEqual(JSON.parse(worker.stdout()), { kind: "idle" });
    assert.equal(result.mcpGoneAtWorkerExit, true);
    assert.ok(existsSync(join(f.root, "mcp.pid")));
    assert.ok(existsSync(f.closingFile));
    assert.equal(f.gone(), true);
    assert.deepEqual(financialTables(join(f.root, "control.sqlite")), before);
    assert.deepEqual(https.requests, []);
  },
);

for (const scenario of [
  "empty path",
  "malformed JSON",
  "invalid schema",
  "non-0600 file",
] as const) {
  test(
    `actual Worker main rejects ${scenario} financial configuration before creating model, MCP or storage`,
    { timeout: 15_000 },
    async (t) => {
      const f = bootstrapProcessFixture(t);
      const https = await financialHttps(t, f.root);
      const configPath = join(f.root, "financial.json");
      const value = https.configuration();
      writeFileSync(
        configPath,
        scenario === "malformed JSON"
          ? "{"
          : JSON.stringify(
              scenario === "invalid schema"
                ? {
                    ...value,
                    schemaVersion:
                      "crewon.plugin-credit-settlement-worker.unknown",
                  }
                : value,
            ),
        { mode: 0o600 },
      );
      if (scenario === "non-0600 file") chmodSync(configPath, 0o644);
      const worker = f.start({
        [PLUGIN_CREDIT_SETTLEMENT_WORKER_CONFIG_ENV]:
          scenario === "empty path" ? "" : configPath,
        ...https.environment,
        CREWON_MODEL_ADAPTER: "invalid-model-must-not-be-created",
      });
      const result = await worker.completion;
      assert.equal(result.code, 1, worker.stderr());
      assert.equal(result.signal, null);
      assert.match(
        worker.stderr(),
        /plugin_credit_settlement_worker_configuration_invalid/u,
      );
      assert.doesNotMatch(
        worker.stderr(),
        /invalid-model-must-not-be-created/u,
      );
      assertTokenRedacted(worker.stderr(), https.environment);
      assert.equal(worker.stdout(), "");
      assert.equal(existsSync(join(f.root, "control.sqlite")), false);
      assert.equal(existsSync(join(f.root, "mcp.pid")), false);
      assert.equal(existsSync(f.closingFile), false);
      assert.equal(result.mcpGoneAtWorkerExit, false);
      assert.deepEqual(https.requests, []);
    },
  );
}

test(
  "actual Worker main rejects a financial tenant mismatch before financial HTTPS, current Worker MCP and Store startup",
  { timeout: 15_000 },
  async (t) => {
    const f = bootstrapProcessFixture(t);
    const https = await financialHttps(
      t,
      f.root,
      "foreign-financial-process-test-tenant",
    );
    const configPath = join(f.root, "financial.json");
    writeFileSync(configPath, JSON.stringify(https.configuration()), {
      mode: 0o600,
    });
    const worker = f.start({
      [PLUGIN_CREDIT_SETTLEMENT_WORKER_CONFIG_ENV]: configPath,
      ...https.environment,
      CREWON_MODEL_ADAPTER: "invalid-model-must-not-be-created",
    });
    const result = await worker.completion;
    assert.equal(result.code, 1, worker.stderr());
    assert.equal(result.signal, null);
    assert.match(worker.stderr(), /plugin_credit_settlement_tenant_mismatch/u);
    assert.doesNotMatch(worker.stderr(), /invalid-model-must-not-be-created/u);
    assertTokenRedacted(worker.stderr(), https.environment);
    assert.equal(worker.stdout(), "");
    assert.equal(existsSync(join(f.root, "control.sqlite")), false);
    assert.equal(existsSync(join(f.root, "mcp.pid")), false);
    assert.equal(existsSync(f.closingFile), false);
    assert.equal(result.mcpGoneAtWorkerExit, false);
    assert.deepEqual(https.requests, []);
  },
);

test(
  "actual Worker Main financial HTTPS deny after MCP startup waits for that child's physical cleanup",
  { timeout: 20_000 },
  async (t) => {
    const f = bootstrapProcessFixture(t, { holdCloseUntilReleased: true });
    await f.activate();
    rmSync(join(f.root, "mcp.pid"), { force: true });
    let mcpAliveWhenDenied = false;
    const https = await createPluginCreditSettlementWorkerHttpFixture({
      directory: f.root,
      scope: {
        tenantId: "standalone-tenant",
        spaceId: "financial-process-test-space",
        profileId: "financial-process-test-profile",
      },
      observeRequest(request) {
        assert.equal(request.path, "/authorize");
        assert.ok(existsSync(join(f.root, "mcp.pid")));
        mcpAliveWhenDenied = !f.gone();
      },
    });
    t.after(() => https.close());
    https.setAuthorization("deny");
    const configPath = await https.writeConfiguration(
      join(f.root, "financial-deny.json"),
    );
    const before = financialTables(join(f.root, "control.sqlite"));
    const worker = f.start({
      ...https.environment,
      [PLUGIN_CREDIT_SETTLEMENT_WORKER_CONFIG_ENV]: configPath,
    });
    let finished = false;
    void worker.completion.then(() => {
      finished = true;
    });
    try {
      await waitForFinancialMain(
        () => existsSync(f.closingFile),
        "Main did not close its started MCP after financial deny",
      );
      assert.equal(mcpAliveWhenDenied, true);
      assert.equal(f.gone(), false);
      assert.equal(
        finished,
        false,
        "Main exited before the original held MCP close completed",
      );
      f.releaseClose();
      const result = await completeFinancialMain(worker);
      assert.equal(result.code, 1, worker.stderr());
      assert.equal(result.signal, null);
      assert.equal(result.mcpGoneAtWorkerExit, true);
      assert.equal(f.gone(), true);
      assert.match(
        worker.stderr(),
        /plugin_credit_settlement_worker_authority_denied/u,
      );
      assertTokenRedacted(worker.stderr(), https.environment);
      assert.equal(worker.stdout(), "");
      assert.deepEqual(
        https.requests.map((request) => [
          request.path,
          request.responseOutcome,
        ]),
        [["/authorize", "deny"]],
      );
      assert.deepEqual(financialTables(join(f.root, "control.sqlite")), before);
    } finally {
      f.releaseClose();
    }
  },
);

test(
  "actual Worker Main uses original indexed v1 paid facts and real HTTPS refresh, hold, settle18, then cold immutable recovery",
  { timeout: 30_000 },
  async (t) => {
    const f = await financialMainProcessFixture(t);
    const https = await createPluginCreditSettlementWorkerHttpFixture({
      directory: f.bootstrap.root,
      scope: f.scope,
    });
    t.after(() => https.close());
    const configPath = await https.writeConfiguration(
      join(f.bootstrap.root, "financial-paid.json"),
      { migrate: true },
    );
    const worker = f.start({
      ...https.environment,
      [PLUGIN_CREDIT_SETTLEMENT_WORKER_CONFIG_ENV]: configPath,
    });
    try {
      await f.started(worker);
      await waitForFinancialMain(
        () =>
          https.requests.some(
            (request) =>
              request.path === "/decide" && request.responseOutcome === "hold",
          ),
        "original Main never scanned the ready paid v1 admission",
      );
      const held = https.requests.find(
        (request) => request.path === "/decide",
      )!;
      assert.deepEqual(held.evidence, f.originalEvidence);
      const originalHold = await f.facts.credits.getReservation({
        scope: f.facts.admission.reservation.scope,
        reservationId: f.facts.locator.runId,
      });
      assert.equal(originalHold?.state, "reserved");
      assert.deepEqual(
        await f.facts.credits.getAccount(f.originalEvidence.scope),
        f.originalAccount,
      );
      assert.equal(
        await f.facts.count("plugin_credit_entries"),
        f.originalLedgerEntries,
      );
      assert.equal(
        await f.facts.settlement.getFinalization(f.facts.locator),
        null,
      );
      https.setDecision("settle18");
      await waitForFinancialMain(
        async () =>
          (await f.facts.settlement.getFinalization(f.facts.locator)) !== null,
        "original Main did not atomically settle the explicit HTTPS decision",
      );
      const saved = await f.facts.settlement.getFinalization(f.facts.locator);
      assert.ok(saved);
      assert.equal(saved.decision.authorityId, https.authorityId);
      assert.equal(saved.decision.authorityRevision, https.authorityRevision);
      assert.equal(
        saved.decision.evidenceDigest,
        f.originalEvidence.evidenceDigest,
      );
      assert.deepEqual(saved.decision.outcome, {
        kind: "settle",
        actualCredits: "18",
      });
      assert.equal(saved.reservation.state, "settled");
      assert.equal(saved.account.availableCredits, "82");
      assert.equal(saved.account.reservedCredits, "0");
      assert.equal(saved.account.spentCredits, "18");
      assert.equal(
        await f.facts.count("plugin_credit_entries"),
        f.originalLedgerEntries + 1,
      );
      assert.equal(
        https.requests.filter(
          (request) =>
            request.path === "/decide" &&
            request.responseOutcome === "settle18",
        ).length,
        1,
      );
      assert.ok(
        https.requests.filter((request) => request.path === "/authorize")
          .length >= 6,
        "actual prepare/round/service authorization refreshes were not observed",
      );
      assert.deepEqual(
        await f.facts.parent.listRunEvents(f.facts.locator, 0, 100),
        f.originalEvents,
      );
      await f.stop(worker);
      const decisions = https.requests.filter(
        (request) => request.path === "/decide",
      ).length;
      const authorizations = https.requests.filter(
        (request) => request.path === "/authorize",
      ).length;
      https.setDecision("hold");
      const coldPath = await https.writeConfiguration(
        join(f.bootstrap.root, "financial-cold.json"),
        { migrate: false },
      );
      const cold = f.start({
        ...https.environment,
        [PLUGIN_CREDIT_SETTLEMENT_WORKER_CONFIG_ENV]: coldPath,
      });
      try {
        await f.started(cold);
        await waitForFinancialMain(() => {
          // prepare, round and Service's first check precede getFinalization.
          // Its fourth authorization is requested only after the original immutable read.
          const fourth = https.requests.filter(
            (request) => request.path === "/authorize",
          )[authorizations + 3];
          return fourth !== undefined && https.responseCompleted(fourth.index);
        }, "cold Main did not complete the authorization response after its original finalization read");
        await f.stop(cold);
        assert.equal(
          https.requests.filter((request) => request.path === "/decide").length,
          decisions,
        );
        assert.deepEqual(
          await f.facts.settlement.getFinalization(f.facts.locator),
          saved,
        );
        assert.equal(
          await f.facts.count("plugin_credit_entries"),
          f.originalLedgerEntries + 1,
        );
        assert.deepEqual(
          await f.facts.parent.listRunEvents(f.facts.locator, 0, 100),
          f.originalEvents,
        );
      } finally {
        if (cold.child.exitCode === null && cold.child.signalCode === null)
          await f.stop(cold);
      }
      assertTokenRedacted(
        worker.stdout() + worker.stderr() + cold.stdout() + cold.stderr(),
        https.environment,
      );
      assert.deepEqual(https.failures, []);
    } finally {
      if (worker.child.exitCode === null && worker.child.signalCode === null)
        await f.stop(worker);
    }
  },
);

test(
  "actual Worker Main HTTPS withdrawal preserves the original paid hold and cannot be reauthorized in that owner",
  { timeout: 30_000 },
  async (t) => {
    const f = await financialMainProcessFixture(t);
    const https = await createPluginCreditSettlementWorkerHttpFixture({
      directory: f.bootstrap.root,
      scope: f.scope,
    });
    t.after(() => https.close());
    const configPath = await https.writeConfiguration(
      join(f.bootstrap.root, "financial-withdraw.json"),
      { migrate: true },
    );
    const worker = f.start({
      ...https.environment,
      [PLUGIN_CREDIT_SETTLEMENT_WORKER_CONFIG_ENV]: configPath,
    });
    try {
      await f.started(worker);
      await waitForFinancialMain(
        () => https.requests.some((request) => request.path === "/decide"),
        "original Main did not observe the paid hold",
      );
      https.setAuthorization("deny");
      await waitForFinancialMain(
        () =>
          https.requests.some(
            (request) =>
              request.path === "/authorize" &&
              request.responseOutcome === "deny",
          ),
        "original Main did not receive explicit financial withdrawal",
      );
      const held = await f.facts.credits.getReservation({
        scope: f.facts.admission.reservation.scope,
        reservationId: f.facts.locator.runId,
      });
      assert.equal(held?.state, "reserved");
      const requests = https.requests.length;
      https.setAuthorization("allow");
      https.setDecision("settle18");
      // The normal Worker continues polling; the withdrawn financial owner must never open a new HTTP round.
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      assert.equal(https.requests.length, requests);
      assert.equal(
        await f.facts.settlement.getFinalization(f.facts.locator),
        null,
      );
      assert.equal(
        (
          await f.facts.credits.getReservation({
            scope: f.facts.admission.reservation.scope,
            reservationId: f.facts.locator.runId,
          })
        )?.state,
        "reserved",
      );
      assert.deepEqual(
        await f.facts.credits.getAccount(f.originalEvidence.scope),
        f.originalAccount,
      );
      assert.equal(
        await f.facts.count("plugin_credit_entries"),
        f.originalLedgerEntries,
      );
      assert.deepEqual(
        await f.facts.parent.listRunEvents(f.facts.locator, 0, 100),
        f.originalEvents,
      );
      await f.stop(worker);
      assertTokenRedacted(worker.stdout() + worker.stderr(), https.environment);
      assert.deepEqual(https.failures, []);
    } finally {
      if (worker.child.exitCode === null && worker.child.signalCode === null)
        await f.stop(worker);
    }
  },
);

test(
  "actual Worker Main shutdown aborts an in-flight HTTPS decision body, physically retires MCP and never settles it",
  { timeout: 30_000 },
  async (t) => {
    const f = await financialMainProcessFixture(t);
    const https = await createPluginCreditSettlementWorkerHttpFixture({
      directory: f.bootstrap.root,
      scope: f.scope,
    });
    t.after(() => https.close());
    https.setDecision("settle18");
    const held = https.holdNextResponse("/decide");
    const configPath = await https.writeConfiguration(
      join(f.bootstrap.root, "financial-held-body.json"),
      { migrate: true },
    );
    const worker = f.start({
      ...https.environment,
      [PLUGIN_CREDIT_SETTLEMENT_WORKER_CONFIG_ENV]: configPath,
    });
    let bodyEntered = false;
    let bodyClosed = false;
    void held.entered.then(() => {
      bodyEntered = true;
    });
    void held.closed.then(() => {
      bodyClosed = true;
    });
    try {
      await f.started(worker);
      await waitForFinancialMain(
        () => bodyEntered,
        "actual decision response body was not held",
      );
      assert.equal(
        await f.facts.settlement.getFinalization(f.facts.locator),
        null,
      );
      assert.equal(
        bodyClosed,
        false,
        "decision body must remain in flight before SIGTERM",
      );
      await f.stop(worker);
      await waitForFinancialMain(
        () => bodyClosed,
        "original fetch abort did not physically close the held HTTPS response",
      );
      assert.equal(f.bootstrap.gone(), true);
      assert.equal(
        await f.facts.settlement.getFinalization(f.facts.locator),
        null,
      );
      assert.equal(
        (
          await f.facts.credits.getReservation({
            scope: f.facts.admission.reservation.scope,
            reservationId: f.facts.locator.runId,
          })
        )?.state,
        "reserved",
      );
      assert.deepEqual(
        await f.facts.credits.getAccount(f.originalEvidence.scope),
        f.originalAccount,
      );
      assert.equal(
        await f.facts.count("plugin_credit_entries"),
        f.originalLedgerEntries,
      );
      assert.deepEqual(
        await f.facts.parent.listRunEvents(f.facts.locator, 0, 100),
        f.originalEvents,
      );
      assertTokenRedacted(worker.stdout() + worker.stderr(), https.environment);
      assert.deepEqual(https.failures, []);
    } finally {
      held.release();
      if (worker.child.exitCode === null && worker.child.signalCode === null)
        await f.stop(worker);
    }
  },
);
