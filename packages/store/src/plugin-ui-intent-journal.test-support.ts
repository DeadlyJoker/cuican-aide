import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import type { PluginUiIntentPayloadVerifier } from "@crewon/application";
import {
  extensionCanonicalJson,
  parsePluginTaskAdmissionPin,
  type PluginUiIntentKind,
} from "@crewon/domain";
import {
  parseProjectGenerationUiActionRequest,
  parseProjectGenerationUiActionResponse,
  parseProjectGenerationQueryUiActionRequest,
  parseProjectGenerationQueryUiActionResponse,
  parseProjectGenerationSelectionUiActionRequest,
  parseProjectGenerationSelectionUiActionResponse,
} from "@crewon/contracts/plugins";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import {
  actor,
  scope,
  timestamp,
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";
import { uiIntentDigester } from "./plugin-ui-intent-store-support.ts";
export { timestamp };
export const intentAuthority = Object.freeze({
  assertCurrent: async () => {},
  assertActive() {},
});
export const intentVerifier: PluginUiIntentPayloadVerifier = Object.freeze({
  verifyRequest({
    kind,
    action,
    requestJson,
  }: Parameters<PluginUiIntentPayloadVerifier["verifyRequest"]>[0]) {
    const raw = JSON.parse(requestJson);
    const parsed =
      kind === "generation"
        ? parseProjectGenerationUiActionRequest(raw)
        : kind === "query"
          ? parseProjectGenerationQueryUiActionRequest(raw)
          : parseProjectGenerationSelectionUiActionRequest(raw);
    assert.equal(parsed.action, action);
    assert.equal(extensionCanonicalJson(parsed), requestJson);
  },
  verifyReceipt({
    kind,
    requestJson,
    receiptJson,
  }: Parameters<PluginUiIntentPayloadVerifier["verifyReceipt"]>[0]) {
    const request = JSON.parse(requestJson),
      output = JSON.parse(receiptJson);
    const result =
      kind === "generation"
        ? parseProjectGenerationUiActionResponse(request, output)
        : kind === "query"
          ? parseProjectGenerationQueryUiActionResponse(request, output)
          : parseProjectGenerationSelectionUiActionResponse(request, output);
    const { disposition: _d, ...logical } = result as { disposition: string };
    return {
      receiptIdentityDigest: uiIntentDigester.sha256(
        extensionCanonicalJson(logical),
      ),
    };
  },
});
export const intentReference = Object.freeze({
  projectId: "intent-project",
  assetId: "intent-concept",
  assetRevision: 1,
  expectedProjectRevision: 3,
  expectedAssetMetadataRevision: 1,
});
export function intentRequest(kind: PluginUiIntentKind, key = "intent-key-1") {
  const action =
    kind === "generation"
      ? "crewon.project-generations.v1.generateConcept"
      : kind === "query"
        ? "crewon.project-generation-queries.v1.queryConceptGeneration"
        : "crewon.project-generation-selections.v1.selectConceptImage";
  const operationId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const input =
    kind === "generation"
      ? {
          reference: intentReference,
          threadId: "intent-thread",
          expectedThreadRevision: 1,
          idempotencyKey: key,
        }
      : kind === "query"
        ? {
            reference: {
              projectId: intentReference.projectId,
              assetId: intentReference.assetId,
              assetRevision: 1,
            },
            operationId,
            threadId: "intent-thread",
            expectedThreadRevision: 1,
            idempotencyKey: key,
          }
        : {
            reference: intentReference,
            operationId,
            expectedOperationRevision: 2,
            resultIndex: 0,
            expectedSelectionRevision: 0,
            idempotencyKey: key,
          };
  return {
    action,
    input,
    requestJson: extensionCanonicalJson({ action, input }),
  };
}
export function intentReceipt(
  kind: PluginUiIntentKind,
  disposition: "committed" | "replayed" = "committed",
) {
  return extensionCanonicalJson(
    kind === "selection"
      ? {
          disposition,
          selectionRevision: 1,
          selection: {
            reference: {
              projectId: intentReference.projectId,
              assetId: intentReference.assetId,
              assetRevision: 1,
            },
            operationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            operationRevision: 2,
            resultIndex: 0,
            filename: "original-0.png",
            url: "https://provider.example/original/0.png",
            selectedAt: timestamp,
          },
        }
      : {
          disposition,
          threadId: "intent-thread",
          threadRevision: 2,
          runId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          messageId: "intent-message",
          configurationRevision: 1,
        },
  );
}
/** Small real SQL fixture: only the original host plus real installation records, no task/credit sidecars. */
export async function intentJournalFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  prepared = true,
) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-intent-journal-")),
    path = join(directory, "control.sqlite"),
    schema = `intent_${randomUUID().replaceAll("-", "")}`;
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  if (backend === "postgres") assert.ok(connectionString);
  const admin =
      backend === "postgres" ? new Pool({ connectionString, max: 1 }) : null,
    database = backend === "sqlite" ? new DatabaseSync(path) : null;
  const prefix = backend === "postgres" ? `"${schema}".` : "",
    parents: (SqliteRunStore | PostgresDomainStore)[] = [];
  const open = async (migrate = prepared) => {
    const parent =
      backend === "sqlite"
        ? new SqliteRunStore(path)
        : await PostgresDomainStore.open({
            connectionString: connectionString!,
            schema,
            maxPoolSize: 1,
          });
    parents.push(parent);
    const store = parent.pluginUiIntentJournalStore({
      verifier: intentVerifier,
    });
    if (migrate) await store.migratePluginUiIntentJournal();
    return { parent, store };
  };
  t.after(async () => {
    try {
      for (const p of parents) await p.close();
    } finally {
      database?.close();
      try {
        if (admin)
          await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin?.end();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  const first = await open(),
    second = await open();
  const installs = first.parent.pluginInstallationStore();
  await installs.migrate();
  const installed = await installs.recordInstalledPackage(
      installationRecipe("intent-install"),
    ),
    enabled = await installs.commitSelection(
      selectionRecipe(installed.selection, "intent-enable"),
    );
  const pin = (kind: PluginUiIntentKind = "selection") =>
    parsePluginTaskAdmissionPin({
      ...scope,
      principalId: actor.principalId,
      actorId: actor.actorId,
      pluginId: installed.package.pluginId,
      publisherId: installed.package.publisherId,
      version: installed.package.version,
      packageDigest: installed.package.packageDigest,
      selectionRevision: enabled.selection.revision,
      contributionId: "workbench",
      action: intentRequest(kind).action,
      authorityEpoch: "intent-epoch-1",
    });
  const account = () => ({
    controlRealmId: first.store.uiIntentJournalRealmId!,
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    principalId: actor.principalId,
  });
  const input = (
    kind: PluginUiIntentKind = "selection",
    key = "intent-key-1",
  ) => ({
    account: account(),
    sourcePin: pin(kind),
    requestJson: intentRequest(kind, key).requestJson,
    at: timestamp,
  });
  const query = async (sql: string) =>
    database ? database.prepare(sql).all() : (await admin!.query(sql)).rows;
  const execute = async (sql: string) => {
    if (database) database.exec(sql);
    else await admin!.query(sql);
  };
  return {
    backend,
    first,
    second,
    open,
    account,
    input,
    pin,
    installs,
    enabled,
    query,
    execute,
    prefix,
    path,
    schema,
    connectionString,
  };
}

/** Actual SQL guard replacement must produce an unavailable journal, never empty recovery hints. */
export async function assertIntentJournalGuardTamper(
  t: TestContext,
  backend: "sqlite" | "postgres",
  tamper: "literal-case" | "boolean-grouping",
) {
  const f = await intentJournalFixture(t, backend);
  const staged = await f.first.store.stageUiIntent(f.input(), {
    authority: intentAuthority,
  });
  const action = tamper === "literal-case" ? "delete" : "update";
  const name = `plugin_ui_intents_journal_${action}`;
  const rows = await f.query(
    backend === "sqlite"
      ? `SELECT sql AS body FROM sqlite_master WHERE type='trigger' AND name='${name}'`
      : `SELECT p.prosrc AS body FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='${f.schema}' AND p.proname='${name}'`,
  );
  assert.equal(rows.length, 1);
  const original = String(rows[0]!.body);
  const altered =
    tamper === "literal-case"
      ? original.replace(
          "OLD.phase IN ('prepared','dispatched')",
          "OLD.phase IN ('PREPARED','DISPATCHED')",
        )
      : original
          .replace(
            "NEW.control_realm_id<>OLD.control_realm_id",
            "(NEW.control_realm_id<>OLD.control_realm_id",
          )
          .replace(
            "OR (NEW.phase='dispatched' AND NEW.dispatch_attempt_count<>OLD.dispatch_attempt_count+1)",
            "OR NEW.phase='dispatched') AND NEW.dispatch_attempt_count<>OLD.dispatch_attempt_count+1",
          );
  assert.notEqual(altered, original);
  // The old normalization discarded both literal case and grouping and accepted these exact changes.
  const oldCanonical = (value: string) =>
    value.toLowerCase().replace(/[\s()'";]/gu, "");
  assert.equal(oldCanonical(altered), oldCanonical(original));
  if (backend === "sqlite") {
    await f.execute(`DROP TRIGGER ${name}`);
    await f.execute(altered);
  } else {
    await f.execute(
      `CREATE OR REPLACE FUNCTION ${f.prefix}${name}() RETURNS trigger LANGUAGE plpgsql AS $$ ${altered} $$`,
    );
  }
  await assert.rejects(
    () => f.first.store.listUiIntentHints({ account: f.account() }),
    /schema_incomplete/,
  );
  await assert.rejects(
    () => f.second.store.enablePluginUiIntentJournalReads(),
    /schema_incomplete/,
  );
  await assert.rejects(
    () => f.first.store.migratePluginUiIntentJournal(),
    /schema_incomplete/,
  );
  await assert.rejects(
    () =>
      f.first.store.markUiIntentDispatched(
        { ...f.input(), intentId: staged.intent.intentId },
        { authority: intentAuthority },
      ),
    /schema_incomplete/,
  );
  const persisted = await f.query(
    `SELECT intent_id,phase,dispatch_attempt_count FROM ${f.prefix}plugin_ui_intents`,
  );
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]!.intent_id, staged.intent.intentId);
  assert.equal(persisted[0]!.phase, "prepared");
  assert.equal(Number(persisted[0]!.dispatch_attempt_count), 0);
}
