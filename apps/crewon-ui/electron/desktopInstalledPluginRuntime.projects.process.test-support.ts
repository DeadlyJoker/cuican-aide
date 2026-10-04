import assert from "node:assert/strict";
import { chmod, cp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SqliteRunStore } from "@crewon/store";
import { startExternalOperationFixtureRun } from "../../../packages/store/src/external-operation-run.test-support.ts";
import { verifyLocalPluginPackage } from "../../../packages/plugin-host/src/local-plugin-package-verifier.ts";
import {
  parseDesktopProjectExecutionConfiguration,
  type DesktopProjectExecutionConfiguration,
  type InstalledPluginPeerActor,
} from "@crewon/contracts/plugins";
import type { ExtensionConfiguration } from "@crewon/domain";
import {
  DESKTOP_PLUGIN_APPROVAL_FILE,
  DESKTOP_PLUGIN_APPROVAL_SCHEMA,
  DESKTOP_PLUGIN_APPROVAL_SCHEMA_V3,
} from "./desktopPluginBootstrap.ts";

type Source = Readonly<{
  pluginId: string;
  packageDigest: string;
  version: string;
}>;

export async function retainNativeProjectUiSource(
  input: Readonly<{
    directory: string;
    dataDirectory: string;
    packageDirectory: string;
  }>,
) {
  const original = await verifyLocalPluginPackage({
    directory: await realpath(input.packageDirectory),
  });
  assert.equal(original.descriptor.pluginId, "crewon.short-drama");
  assert.equal(original.descriptor.version, "9.0.0");
  assert.equal(original.descriptor.entrypoints.node, null);
  assert.ok(original.descriptor.entrypoints.ui);
  const directory = join(input.directory, "approved-short-drama9");
  await cp(input.packageDirectory, directory, { recursive: true });
  await chmod(directory, 0o700);
  const copied = await verifyLocalPluginPackage({ directory });
  assert.equal(copied.packageDigest, original.packageDigest);
  const source = {
    sourceId: "named-native-epoch-short-drama9",
    directory,
    pluginId: copied.descriptor.pluginId,
    publisherId: copied.descriptor.publisherId,
    version: copied.descriptor.version,
    packageDigest: copied.packageDigest,
  };
  const path = join(input.dataDirectory, DESKTOP_PLUGIN_APPROVAL_FILE);
  const approval = JSON.parse(await readFile(path, "utf8"));
  assert.equal(approval.schemaVersion, DESKTOP_PLUGIN_APPROVAL_SCHEMA);
  approval.sources.push(source);
  approval.publications.push({
    pluginId: source.pluginId,
    publisherId: source.publisherId,
    packageDigest: source.packageDigest,
    publicAssets: [copied.descriptor.entrypoints.ui!.path],
  });
  await writeFile(path, JSON.stringify(approval), { mode: 0o600 });
  return source;
}

/** Named private test approval only. The retained source and target bytes, real
 * configuration identity, and original authority/SDK/Worker boundaries stay intact. */
export async function prepareNativeTaskProjectApproval(
  input: Readonly<{
    dataDirectory: string;
    source: Source;
    target: Source;
    configuration: ExtensionConfiguration;
  }>,
): Promise<DesktopProjectExecutionConfiguration> {
  const path = join(input.dataDirectory, DESKTOP_PLUGIN_APPROVAL_FILE);
  const approval = JSON.parse(await readFile(path, "utf8"));
  assert.equal(approval.schemaVersion, DESKTOP_PLUGIN_APPROVAL_SCHEMA);
  const source = {
    pluginId: input.source.pluginId,
    packageDigest: input.source.packageDigest,
    contributionId: "workbench",
  };
  const target = {
    pluginId: input.target.pluginId,
    packageDigest: input.target.packageDigest,
    contributionId: "studio",
  };
  const projects = parseDesktopProjectExecutionConfiguration(
    {
      version: "crewon.desktop-project-execution.v1",
      pluginUi: { publications: [source] },
      pluginGenerations: {
        publications: [
          { source, target: { ...target, action: "image.generate" } },
        ],
      },
      pluginQueries: {
        publications: [
          { source, target: { ...target, action: "image.query" } },
        ],
      },
      generationReads: { version: "crewon.project-generation-read.v1" },
      generationReadUi: { publications: [source] },
      resultSelections: {
        version: "crewon.project-concept-selection.v1",
        adapter: "comfyui-krea2",
        identities: [
          {
            pluginVersion: input.target.version,
            manifestDigest: input.configuration.manifestDigest,
            implementationDigest: input.configuration.implementationDigest,
          },
        ],
      },
      selectionUi: { publications: [source] },
      uiRecovery: {
        version: "crewon.plugin-ui-recovery.v1",
        publications: [
          {
            ...source,
            actions: [
              "crewon.project-generations.v1.generateConcept",
              "crewon.project-generation-queries.v1.queryConceptGeneration",
              "crewon.project-generation-selections.v1.selectConceptImage",
            ],
          },
        ],
      },
    },
    { publications: approval.publications },
  );
  await writeFile(
    path,
    JSON.stringify({
      ...approval,
      schemaVersion: DESKTOP_PLUGIN_APPROVAL_SCHEMA_V3,
      projects,
    }),
    { mode: 0o600 },
  );
  return projects;
}

/** Only after every actual consumer is physically stopped. This named fixture
 * advances the admitted Run with the original reducer and reserves a real paid
 * external-operation record. No Worker dispatch, model or supplier is claimed. */
export async function seedNativeProjectQuerySource(
  input: Readonly<{
    databasePath: string;
    actor: InstalledPluginPeerActor;
    runId: string;
  }>,
) {
  const parent = new SqliteRunStore(input.databasePath);
  try {
    const extensions = parent.extensionStore();
    const binding = await extensions.loadExtensionRunBinding({
      tenantId: input.actor.tenantId,
      spaceId: input.actor.spaceId,
      runId: input.runId,
    });
    assert.ok(binding);
    await startExternalOperationFixtureRun(parent, binding);
    const operations = parent.externalOperationStore();
    await operations.migrate();
    const operationId = randomUUID();
    const digest = "sha256:" + "d".repeat(64);
    const reserved = await operations.reserveExternalOperation({
      tenantId: binding.tenantId,
      runId: binding.runId,
      bindingDigest: binding.bindingDigest,
      operationId,
      executionId: "named-native-epoch-source-operation",
      idempotencyKey: "named-native-epoch-source-operation-key",
      actionDigest: digest,
      requestDigest: digest,
      correlationId: operationId,
      createdAt: new Date().toISOString(),
    });
    assert.equal(reserved.disposition, "created");
    return { operationId, binding };
  } finally {
    await parent.close();
  }
}

const immutableTables = [
  "extension_mutation_receipts",
  "extension_run_bindings",
  "plugin_task_admissions",
  "plugin_query_task_admissions",
  "extension_credit_admissions",
  "plugin_credit_reservations",
  "plugin_credit_entries",
  "creative_project_generation_links",
  "creative_project_query_links",
  "extension_external_operations",
] as const;

/** Exact persisted records, including original full-pin digests and immutable
 * pricing, rather than counts alone. Mutable dispatch work leases are excluded. */
export function nativeProjectReceiptFacts(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Object.fromEntries(
      immutableTables.map((table) => {
        const present = database
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(table);
        assert.ok(present, `native_project_fixture_schema_missing:${table}`);
        const rows = database.prepare(`SELECT * FROM ${table}`).all();
        assert.ok(rows.length <= 512, "native_project_fixture_record_limit");
        return [table, rows.map((row) => JSON.stringify(row)).sort()];
      }),
    );
  } finally {
    database.close();
  }
}
