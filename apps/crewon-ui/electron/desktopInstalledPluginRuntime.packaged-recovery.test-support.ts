import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type {
  PluginUiRecoveryHint,
  PluginUiRecoveryRequest,
} from "@crewon/contracts";
import { parsePluginUiIntentRecord } from "@crewon/domain";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import type { nativeTaskProcessFixture } from "./desktopInstalledPluginRuntime.tasks.process.test-support.ts";

export const packagedRecoveryIdentity = Object.freeze({
  pluginId: "crewon.short-drama",
  publisherId: "example.publisher",
  version: "9.0.0",
  packageDigest:
    "sha256:981c3bcdb7fc9c47186118a482bb1d8ec3dd1d4f95d3a09139f7a104dfba2334",
});
export const packagedRecoveryActions = Object.freeze({
  generation: "crewon.project-generations.v1.generateConcept",
  query: "crewon.project-generation-queries.v1.queryConceptGeneration",
  selection: "crewon.project-generation-selections.v1.selectConceptImage",
} as const);
export const packagedRecoveryInputs = Object.freeze({
  title: "Named packaged three-lane prepared recovery",
  brief:
    "Named saved brief for prepared request display; no supplier execution or successful operation history.",
  conceptName: "Named prepared recovery concept",
  prompt:
    "Original saved concept prompt.\nGeneration, query and selection are staged only.",
});
export type PackagedRecoveryHttp = Readonly<{
  method: string;
  path: string;
  status: number | null;
  action: string | null;
}>;
export type PackagedRecoveryProof = Readonly<{
  phase: "stage" | "hydrate";
  pid: number;
  formalDocument: string;
  executable: string;
  appPath: string;
  userData: string;
  locale: "zh" | "en";
  localePreferenceChanged: false;
  settingsLabels: readonly string[];
  screenshots: readonly string[];
  packageUiUris: readonly string[];
  http: readonly PackagedRecoveryHttp[];
  businessActionCounts: Readonly<Record<string, number>>;
  requests: readonly PluginUiRecoveryRequest[];
  hints: readonly PluginUiRecoveryHint[];
  savedInputsReadBack: true;
  hydrateResponseAt: number;
  moduleReadyObservedAt: number;
  fixtureStageClient: "original-authenticated-control-client";
  operationHistory: "not-created";
  operationId: string;
  onlineExecution: false;
}>;
export type PackagedRecoveryFixture = Awaited<
  ReturnType<typeof nativeTaskProcessFixture>
>;

/** Reads actual original records. This helper never creates a phase, receipt, operation or funds. */
export function packagedRecoveryDatabaseFacts(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = [
      "creative_projects",
      "creative_project_briefs",
      "creative_concept_assets",
      "creative_concept_revisions",
      "creative_project_mutation_receipts",
      "threads",
      "thread_events",
      "messages",
      "run_snapshots",
      "extension_run_bindings",
      "plugin_task_admissions",
      "extension_credit_admissions",
      "plugin_credit_reservations",
      "plugin_credit_entries",
      "extension_external_operations",
      "creative_project_generation_links",
      "creative_project_query_links",
      "creative_operation_result_links",
      "creative_current_concept_selections",
      "creative_concept_selection_receipts",
    ];
    const facts = Object.fromEntries(
      tables.map((table) => {
        const exists = database
          .prepare("SELECT type FROM main.sqlite_master WHERE name=?")
          .get(table);
        if (exists === undefined) return [table, [] as string[]];
        assert.equal(exists.type, "table");
        const rows = database
          .prepare(`SELECT * FROM main.${table} LIMIT 65`)
          .all();
        assert.ok(rows.length <= 64, "packaged_recovery_fact_limit");
        return [table, rows.map((row) => JSON.stringify(row)).sort()];
      }),
    );
    const selection = database
      .prepare(
        "SELECT record_json FROM main.plugin_profile_selections WHERE plugin_id=?",
      )
      .get(packagedRecoveryIdentity.pluginId);
    const intents = database
      .prepare(
        "SELECT record_json FROM main.plugin_ui_intents ORDER BY sequence LIMIT 4",
      )
      .all();
    assert.ok(intents.length <= 3);
    return {
      facts,
      selection: selection
        ? (JSON.parse(String(selection.record_json)) as Record<string, unknown>)
        : null,
      intents: intents.map((row) =>
        parsePluginUiIntentRecord(
          JSON.parse(String(row.record_json)),
          extensionStoreDigester,
        ),
      ),
    };
  } finally {
    database.close();
  }
}

/** Reuse retained original bytes; requirements stay exactly the existing project fixture's. */
export async function packagedRecoveryDirectories() {
  const professionalDirectory =
    process.env.CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR;
  const kreaDirectory = process.env.CREWON_TEST_KREA_PLUGIN_DIR;
  const projectUiDirectory =
    process.env.CREWON_TEST_SHORT_DRAMA_RECOVERY_DIRECTORY;
  assert.ok(professionalDirectory && kreaDirectory && projectUiDirectory);
  const directories = await Promise.all(
    [professionalDirectory, kreaDirectory, projectUiDirectory].map((path) =>
      realpath(path),
    ),
  );
  return {
    professionalDirectory: directories[0]!,
    kreaDirectory: directories[1]!,
    projectUiDirectory: directories[2]!,
  };
}

export function assertPreparedPackagedRecovery(proof: PackagedRecoveryProof) {
  assert.equal(proof.requests.length, 3);
  assert.equal(proof.hints.length, 3);
  assert.equal(proof.onlineExecution, false);
  assert.equal(proof.operationHistory, "not-created");
  assert.equal(
    proof.fixtureStageClient,
    "original-authenticated-control-client",
  );
  for (const request of proof.requests) {
    const hint = proof.hints.find(
      (value) => value.request.action === request.action,
    );
    assert.ok(hint);
    assert.deepEqual(hint.request, request);
    for (const [key, value] of Object.entries(packagedRecoveryIdentity))
      assert.equal(
        hint.sourcePin[key as keyof typeof packagedRecoveryIdentity],
        value,
      );
    assert.equal(hint.sourcePin.contributionId, "workbench");
    assert.equal(hint.sourcePin.selectionRevision, 2);
    assert.equal(hint.phase, "prepared");
    assert.equal(hint.dispatchAttemptCount, 0);
    assert.equal(hint.dispatchMayHaveOccurred, false);
    assert.equal(hint.receipt, null);
    assert.equal(hint.retryable, true);
  }
}
