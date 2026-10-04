import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import test from "node:test";
import {
  assertPluginCreditSettlementWorkerConfig,
  loadPluginCreditSettlementWorkerConfig,
  loadPluginCreditSettlementWorkerConfigFromEnvironment,
  parsePluginCreditSettlementWorkerConfig,
} from "./plugins/plugin-credit-settlement-worker-config.ts";
import { createPluginCreditSettlementWorkerAuthority } from "./plugins/plugin-credit-settlement-worker-authority.ts";
import {
  financialConfigDocument,
  financialEnvironment,
  financialScope,
  financialToken,
} from "./plugin-credit-settlement-worker.test-support.ts";

test("financial deployment configuration is independently opt-in, explicit, branded and redacted", async () => {
  assert.equal(
    loadPluginCreditSettlementWorkerConfigFromEnvironment({
      CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH: "/not-read/execution.json",
    }),
    undefined,
  );
  const document = financialConfigDocument();
  const config = parsePluginCreditSettlementWorkerConfig(
    document,
    financialEnvironment,
  );
  assert.deepEqual(config.scope, financialScope);
  assert.equal(config.migrate, false);
  assertPluginCreditSettlementWorkerConfig(config);
  assert.equal(JSON.stringify(config).includes(financialToken), false);
  assert.equal(inspect(config).includes(financialToken), false);
  assert.throws(
    () => createPluginCreditSettlementWorkerAuthority({ ...config }),
    /configuration_invalid/u,
  );
  const owner = createPluginCreditSettlementWorkerAuthority(
    config,
    async () => {
      throw new Error("not called by construction");
    },
  );
  assert.throws(() => owner.assertCurrent(), /not_authorized/u);
  await owner.close();
});

for (const [name, patch] of [
  ["schema", { schemaVersion: "crewon.installed-plugin-worker.v1" }],
  ["missing price-free authority", { authorityId: undefined }],
  ["implicit migrate", { migrate: undefined }],
  ["extra funding", { initialCredits: "100" }],
  ["extra execution authorization", { policyAuthority: {} }],
  ["batch zero", { batchSize: 0 }],
  ["batch overflow", { batchSize: 17 }],
  ["timeout overflow", { timeoutMs: 30001 }],
  ["age overflow", { maxAuthorizationAgeMs: 30001 }],
  ["round overflow", { maxRoundMs: 30001 }],
  ["interval overflow", { intervalMs: 3600001 }],
  [
    "HTTP authority",
    {
      authorizationAuthority: {
        url: "http://127.0.0.1/authorize",
        serviceTokenEnvironmentVariable: "NAMED_FINANCIAL_AUTHORIZATION_TOKEN",
      },
    },
  ],
  [
    "URL credentials",
    {
      decisionAuthority: {
        url: "https://secret@financial.example/decide",
        serviceTokenEnvironmentVariable: "NAMED_FINANCIAL_DECISION_TOKEN",
      },
    },
  ],
  [
    "URL query",
    {
      decisionAuthority: {
        url: "https://financial.example/decide?secret=x",
        serviceTokenEnvironmentVariable: "NAMED_FINANCIAL_DECISION_TOKEN",
      },
    },
  ],
] as const) {
  test(`financial configuration rejects ${name} without defaults`, () => {
    assert.throws(
      () =>
        parsePluginCreditSettlementWorkerConfig(
          financialConfigDocument(patch),
          financialEnvironment,
        ),
      /configuration_invalid/u,
    );
  });
}

test("financial configuration and token/environment lookup never execute getters", () => {
  let calls = 0;
  const config = financialConfigDocument();
  Object.defineProperty(config, "authorityId", {
    enumerable: true,
    get() {
      calls += 1;
      return "invented";
    },
  });
  assert.throws(
    () => parsePluginCreditSettlementWorkerConfig(config, financialEnvironment),
    /configuration_invalid/u,
  );
  const environment = Object.defineProperty(
    {},
    "NAMED_FINANCIAL_AUTHORIZATION_TOKEN",
    {
      get() {
        calls += 1;
        return financialToken;
      },
    },
  );
  assert.throws(
    () =>
      parsePluginCreditSettlementWorkerConfig(
        financialConfigDocument(),
        environment,
      ),
    /configuration_invalid/u,
  );
  const pathEnvironment = Object.defineProperty(
    {},
    "CREWON_PLUGIN_CREDIT_SETTLEMENT_CONFIG_PATH",
    {
      get() {
        calls += 1;
        return "/invented/path";
      },
    },
  );
  assert.throws(
    () =>
      loadPluginCreditSettlementWorkerConfigFromEnvironment(pathEnvironment),
    /configuration_invalid/u,
  );
  assert.equal(calls, 0);
  for (const token of [undefined, "short", financialToken + "\n"])
    assert.throws(
      () =>
        parsePluginCreditSettlementWorkerConfig(financialConfigDocument(), {
          ...financialEnvironment,
          NAMED_FINANCIAL_AUTHORIZATION_TOKEN: token,
        }),
      /configuration_invalid/u,
    );
});

test("financial configuration requires unchanged bounded owned 0600 bytes and rejects links or invalid UTF-8", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-financial-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "financial.json");
  writeFileSync(path, JSON.stringify(financialConfigDocument()), {
    mode: 0o600,
  });
  assert.deepEqual(
    loadPluginCreditSettlementWorkerConfig(path, financialEnvironment).scope,
    financialScope,
  );
  assert.deepEqual(
    loadPluginCreditSettlementWorkerConfigFromEnvironment({
      ...financialEnvironment,
      CREWON_PLUGIN_CREDIT_SETTLEMENT_CONFIG_PATH: path,
    })?.scope,
    financialScope,
  );
  for (const mode of [0o644, 0o400]) {
    chmodSync(path, mode);
    assert.throws(
      () => loadPluginCreditSettlementWorkerConfig(path, financialEnvironment),
      /configuration_invalid/u,
    );
  }
  chmodSync(path, 0o600);
  const symbolic = join(directory, "symbolic.json");
  symlinkSync(path, symbolic);
  assert.throws(
    () =>
      loadPluginCreditSettlementWorkerConfig(symbolic, financialEnvironment),
    /configuration_invalid/u,
  );
  const hard = join(directory, "hard.json");
  linkSync(path, hard);
  assert.throws(
    () => loadPluginCreditSettlementWorkerConfig(path, financialEnvironment),
    /configuration_invalid/u,
  );
  rmSync(hard);
  writeFileSync(path, Buffer.from([0xff]));
  assert.throws(
    () => loadPluginCreditSettlementWorkerConfig(path, financialEnvironment),
    /configuration_invalid/u,
  );
  writeFileSync(path, "x".repeat(64 * 1024 + 1));
  assert.throws(
    () => loadPluginCreditSettlementWorkerConfig(path, financialEnvironment),
    /configuration_invalid/u,
  );
});
