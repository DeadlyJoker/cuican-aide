import assert from "node:assert/strict";
import test from "node:test";
import { PluginUiRecoveryApplicationService } from "@crewon/application";
import {
  recoveryFixture,
  recoveryRequest,
} from "../../../packages/application/src/plugin-ui-recovery.test-support.ts";
import {
  capturePluginUiRecoveryConfiguration,
  prepareProductionPluginUiRecovery,
  assertProductionPluginUiRecoveryConfiguration,
} from "./plugin-ui-recovery-composition.ts";
import { closeResources } from "./production-control-resource-cleanup.ts";
import { ProductionControlApiIdentity } from "./production-security-adapters.ts";

test("absent recovery configuration never acquires its Store adapter or invokes identity", async () => {
  let calls = 0;
  const result = await prepareProductionPluginUiRecovery({
    configuration: undefined,
    owner: {
      pluginUiIntentJournalStore() {
        calls++;
        throw new Error("unexpected_adapter");
      },
    },
    identity: {} as never,
    ui: undefined,
    clock: { now: () => "2026-10-04T00:00:00.000Z" },
    digester: { sha256: () => "never" },
    owners: { generation: undefined, query: undefined, selection: undefined },
    onDiagnostic() {},
  });
  assert.equal(result, undefined);
  assert.equal(calls, 0);
});

test("recovery configuration captures exact action set without getter or unknown-action execution", () => {
  const f = recoveryFixture(),
    publication = {
      pluginId: f.state.package.pluginId,
      packageDigest: f.state.package.packageDigest,
      contributionId: "workbench",
      actions: [recoveryRequest().action],
    };
  const parsed = capturePluginUiRecoveryConfiguration({
    version: "crewon.plugin-ui-recovery.v1",
    publications: [publication],
  })!;
  publication.actions.push(recoveryRequest("query").action);
  assert.equal(parsed.publications[0]!.actions.length, 1);
  assert.throws(() =>
    capturePluginUiRecoveryConfiguration({
      version: "1",
      publications: [publication],
    }),
  );
  assert.throws(() =>
    capturePluginUiRecoveryConfiguration({
      version: "crewon.plugin-ui-recovery.v1",
      publications: [{ ...publication, actions: ["arbitrary.action"] }],
    }),
  );
  let calls = 0;
  const getter = Object.defineProperty({}, "version", {
    enumerable: true,
    get() {
      calls++;
      return "crewon.plugin-ui-recovery.v1";
    },
  });
  assert.throws(() => capturePluginUiRecoveryConfiguration(getter));
  assert.equal(calls, 0);
});

test("pure production approval rejects missing original source owner before database startup", () => {
  const f = recoveryFixture(),
    configuration = capturePluginUiRecoveryConfiguration({
      version: "crewon.plugin-ui-recovery.v1",
      publications: [
        {
          pluginId: f.state.package.pluginId,
          packageDigest: f.state.package.packageDigest,
          contributionId: "workbench",
          actions: [recoveryRequest().action],
        },
      ],
    })!;
  const identity = new ProductionControlApiIdentity({
    expectedIssuer: "https://recovery-issuer.example.test",
    expectedAudience: "crewon-recovery-tests",
    trustedBff: { verify() {} },
    tokens: {
      verify: async () => {
        throw new Error("must_not_read_identity");
      },
    },
    timeoutMs: 1000,
    deadline: {
      run: async (_timeout, work) => work(new AbortController().signal),
    },
  });
  const config = {
    identity,
    pluginUi: {
      configuration: {
        publications: [
          {
            pluginId: f.state.package.pluginId,
            packageDigest: f.state.package.packageDigest,
          },
        ],
      },
    },
  } as never;
  assert.throws(() =>
    assertProductionPluginUiRecoveryConfiguration(config, configuration),
  );
});

test("structural source owner cannot publish recovery availability or cause migration", async () => {
  const f = recoveryFixture();
  let calls = 0;
  const configuration = capturePluginUiRecoveryConfiguration({
    version: "crewon.plugin-ui-recovery.v1",
    publications: [
      {
        pluginId: f.state.package.pluginId,
        packageDigest: f.state.package.packageDigest,
        contributionId: "workbench",
        actions: [recoveryRequest().action],
      },
    ],
  })!;
  const identity = new ProductionControlApiIdentity({
    expectedIssuer: "https://recovery-issuer.example.test",
    expectedAudience: "crewon-recovery-tests",
    trustedBff: { verify() {} },
    tokens: {
      verify: async () => {
        throw new Error("unused");
      },
    },
    timeoutMs: 1000,
    deadline: {
      run: async (_timeout, work) => work(new AbortController().signal),
    },
  });
  await assert.rejects(() =>
    prepareProductionPluginUiRecovery({
      configuration,
      owner: {
        pluginUiIntentJournalStore() {
          calls++;
          throw new Error("unexpected_adapter");
        },
      },
      identity,
      ui: {} as never,
      clock: { now: () => "unused" },
      digester: { sha256: () => "unused" },
      owners: {
        generation: undefined,
        query: undefined,
        selection: {
          hostUiServices: () => ({ isAvailable: () => true }),
        } as never,
      },
      onDiagnostic() {},
    }),
  );
  assert.equal(calls, 0);
  assert.ok(f.recovery instanceof PluginUiRecoveryApplicationService);
});

test("extracted production cleanup keeps original ordered all-resource failure aggregation", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () =>
      closeResources([
        () => {
          calls.push("first");
          throw new Error("first");
        },
        async () => {
          calls.push("second");
          throw new Error("second");
        },
        () => {
          calls.push("last");
        },
      ]),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.message === "production_control_api_cleanup_failed",
  );
  assert.deepEqual(calls, ["first", "second", "last"]);
});
