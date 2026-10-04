import assert from "node:assert/strict";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { bootstrapProcessFixture } from "./runtime-bootstrap-process.test-support.ts";
import { installedWorkerProcessFixture } from "./installed-plugin-worker-process.test-support.ts";
import {
  PLUGIN_CREDIT_SETTLEMENT_WORKER_CONFIG_ENV,
  PLUGIN_CREDIT_SETTLEMENT_WORKER_SCHEMA,
} from "./plugins/plugin-credit-settlement-worker-config.ts";

const tokenEnvironmentVariable = "FINANCIAL_PROCESS_TEST_AUTHORITY_TOKEN";
const namedTestToken = "independent-financial-process-test-token-000001";

function configuration(url: string, tenantId = "standalone-tenant") {
  return {
    schemaVersion: PLUGIN_CREDIT_SETTLEMENT_WORKER_SCHEMA,
    scope: {
      tenantId,
      spaceId: "financial-process-test-space",
      profileId: "financial-process-test-profile",
    },
    authorityId: "financial-process-test-authority",
    authorityRevision: "financial-process-test-policy",
    authorizationAuthority: {
      url,
      serviceTokenEnvironmentVariable: tokenEnvironmentVariable,
    },
    decisionAuthority: {
      url,
      serviceTokenEnvironmentVariable: tokenEnvironmentVariable,
    },
    timeoutMs: 1_000,
    maxAuthorizationAgeMs: 1_000,
    batchSize: 1,
    intervalMs: 100,
    maxRoundMs: 1_000,
    migrate: false,
  };
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
    const https = await installedWorkerProcessFixture(t);
    const configPath = join(f.root, "financial.json");
    writeFileSync(
      configPath,
      JSON.stringify(configuration(https.configuration().actorAuthority.url)),
      { mode: 0o600 },
    );
    await f.activate();
    // Activation has its own MCP process. Its stale pid must not prove Worker cleanup.
    rmSync(join(f.root, "mcp.pid"), { force: true });
    const before = financialTables(join(f.root, "control.sqlite"));
    assert.deepEqual(before, []);
    const worker = f.start({
      NODE_EXTRA_CA_CERTS: https.environment.NODE_EXTRA_CA_CERTS,
      [tokenEnvironmentVariable]: namedTestToken,
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
    assert.deepEqual(https.authorityRequests, []);
    assert.deepEqual(https.modelRequests, []);
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
      const https = await installedWorkerProcessFixture(t);
      const configPath = join(f.root, "financial.json");
      const value = configuration(https.configuration().actorAuthority.url);
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
        [tokenEnvironmentVariable]: namedTestToken,
        NODE_EXTRA_CA_CERTS: https.environment.NODE_EXTRA_CA_CERTS,
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
      assert.doesNotMatch(worker.stderr(), new RegExp(namedTestToken, "u"));
      assert.equal(worker.stdout(), "");
      assert.equal(existsSync(join(f.root, "control.sqlite")), false);
      assert.equal(existsSync(join(f.root, "mcp.pid")), false);
      assert.equal(existsSync(f.closingFile), false);
      assert.equal(result.mcpGoneAtWorkerExit, false);
      assert.deepEqual(https.authorityRequests, []);
      assert.deepEqual(https.modelRequests, []);
    },
  );
}

test(
  "actual Worker main rejects a financial tenant mismatch before financial HTTPS, current Worker MCP and Store startup",
  { timeout: 15_000 },
  async (t) => {
    const f = bootstrapProcessFixture(t);
    const https = await installedWorkerProcessFixture(t);
    const configPath = join(f.root, "financial.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        configuration(
          https.configuration().actorAuthority.url,
          "foreign-financial-process-test-tenant",
        ),
      ),
      { mode: 0o600 },
    );
    const worker = f.start({
      [PLUGIN_CREDIT_SETTLEMENT_WORKER_CONFIG_ENV]: configPath,
      [tokenEnvironmentVariable]: namedTestToken,
      NODE_EXTRA_CA_CERTS: https.environment.NODE_EXTRA_CA_CERTS,
      CREWON_MODEL_ADAPTER: "invalid-model-must-not-be-created",
    });
    const result = await worker.completion;
    assert.equal(result.code, 1, worker.stderr());
    assert.equal(result.signal, null);
    assert.match(worker.stderr(), /plugin_credit_settlement_tenant_mismatch/u);
    assert.doesNotMatch(worker.stderr(), /invalid-model-must-not-be-created/u);
    assert.doesNotMatch(worker.stderr(), new RegExp(namedTestToken, "u"));
    assert.equal(worker.stdout(), "");
    assert.equal(existsSync(join(f.root, "control.sqlite")), false);
    assert.equal(existsSync(join(f.root, "mcp.pid")), false);
    assert.equal(existsSync(f.closingFile), false);
    assert.equal(result.mcpGoneAtWorkerExit, false);
    assert.deepEqual(https.authorityRequests, []);
    assert.deepEqual(https.modelRequests, []);
  },
);
