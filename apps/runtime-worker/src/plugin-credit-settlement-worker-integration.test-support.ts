import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { PluginCreditSettlementEvidence } from "@crewon/application";
import { sqliteSettlementFixture } from "../../../packages/store/src/sqlite-plugin-credit-settlement.test-support.ts";
import { postgresSettlementFixture } from "../../../packages/store/src/postgres-plugin-credit-settlement.test-support.ts";
import { compositionConfig } from "./runtime-composition.test-support.ts";
import {
  activateStandaloneRuntimeAgentVersionRelease,
  activatePostgresRuntimeAgentVersionRelease,
} from "./agent-version-release-composition.ts";
import {
  createStandaloneRuntimeWorker,
  createPostgresRuntimeWorker,
} from "./standalone-composition.ts";
import type { PluginCreditSettlementRuntimeConfig } from "./plugins/plugin-credit-settlement-runtime-types.ts";

/** Real original paid admission/Run facts; all identity, funds and charging policy are named fixtures. */
export async function financialWorkerFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const fixture =
    backend === "sqlite"
      ? await sqliteSettlementFixture(t)
      : await postgresSettlementFixture(t);
  if (backend === "sqlite")
    await (
      fixture as Awaited<ReturnType<typeof sqliteSettlementFixture>>
    ).complete();
  else
    await (
      fixture as Awaited<ReturnType<typeof postgresSettlementFixture>>
    ).ready();
  const admission = fixture.input.pluginAdmission;
  assert.ok(admission);
  const scope = {
    tenantId: admission.tenantId,
    spaceId: admission.spaceId,
    profileId: admission.profileId,
  };
  const bootstrap = { ...compositionConfig(), runtimeTenantId: scope.tenantId };
  const activation = {
    ...bootstrap,
    actor: {
      principalId: "financial-worker-release-fixture",
      actorId: "financial-worker-release-fixture",
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
    },
    authorization: { authorize: async () => ({ outcome: "allow" as const }) },
    clock: { now: () => new Date().toISOString() },
    activationId: "financial-worker-activation-fixture",
  };
  const pg =
    backend === "postgres"
      ? (fixture as Awaited<ReturnType<typeof postgresSettlementFixture>>)
      : null;
  if (pg === null)
    await activateStandaloneRuntimeAgentVersionRelease({
      ...activation,
      databasePath: fixture.databasePath,
    });
  else
    await activatePostgresRuntimeAgentVersionRelease({
      ...activation,
      connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
      schema: pg.schema,
      maxPoolSize: 1,
    });
  const read =
    pg === null
      ? (fixture as Awaited<ReturnType<typeof sqliteSettlementFixture>>)
          .settlement
      : pg.first;
  const originalEvents = await fixture.parent.listRunEvents(
    fixture.locator,
    0,
    100,
  );
  const counts = { authorizations: 0, decisions: 0, closes: 0 };
  let withdrawn = false;
  let closeTask: Promise<void> | undefined;
  const configured: PluginCreditSettlementRuntimeConfig = {
    scope,
    batchSize: 2,
    intervalMs: 1,
    maxRoundMs: 10_000,
    migrate: true,
    authority: {
      async authorize(signal) {
        signal.throwIfAborted();
        if (withdrawn) throw new Error("fixture_financial_withdrawn");
        counts.authorizations++;
      },
      assertCurrent() {
        if (withdrawn) throw new Error("fixture_financial_withdrawn");
      },
      async decide({ evidence, signal }) {
        signal.throwIfAborted();
        if (withdrawn) throw new Error("fixture_financial_withdrawn");
        assert.equal(evidence.readyToFinalize, true);
        assert.deepEqual(evidence.locator, fixture.locator);
        assert.match(
          evidence.installedAdmissionDigest ?? "",
          /^sha256:[0-9a-f]{64}$/u,
        );
        counts.decisions++;
        return {
          schemaVersion: "crewon.plugin-credit-settlement-decision.v1",
          evidenceDigest: evidence.evidenceDigest,
          authorityId: "worker-financial-authority-fixture",
          authorityRevision: "fixture-price-rule-1",
          decisionId: "worker-financial-decision-fixture",
          outcome: { kind: "settle", actualCredits: "18" },
        };
      },
      close() {
        withdrawn = true;
        if (closeTask === undefined) {
          counts.closes++;
          closeTask = Promise.resolve();
        }
        return closeTask;
      },
    },
  };
  const create = (config = configured) =>
    pg === null
      ? createStandaloneRuntimeWorker({
          ...bootstrap,
          databasePath: fixture.databasePath,
          pluginCreditSettlement: config,
        })
      : createPostgresRuntimeWorker({
          ...bootstrap,
          connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
          schema: pg.schema,
          maxPoolSize: 1,
          pluginCreditSettlement: config,
        });
  return {
    fixture,
    scope,
    configured,
    counts,
    read,
    create,
    originalEvents,
    restartConfig: () => ({
      ...configured,
      migrate: false,
      authority: {
        async authorize(signal: AbortSignal) {
          signal.throwIfAborted();
        },
        assertCurrent() {},
        async decide(_input: {
          evidence: PluginCreditSettlementEvidence;
          signal: AbortSignal;
        }): Promise<never> {
          throw new Error("unexpected_second_financial_decision");
        },
        async close() {},
      },
    }),
  };
}
