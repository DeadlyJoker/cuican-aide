import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import type { WorkflowDeploymentConfiguration } from "@crewon/application";
import { SqliteRunStore } from "@crewon/store";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import { ControlApiClient } from "@crewon/control-client";
import { activateStandaloneRuntimeAgentVersionRelease } from "../../runtime-worker/src/agent-version-release-composition.ts";
import { sharedAgentVersionRuntimeFactory } from "../../runtime-worker/src/shared-agent-version-runtime-factory.ts";
import { createStandaloneRuntimeWorker } from "../../runtime-worker/src/standalone-composition.ts";
import { createStandaloneControlApi } from "./standalone-composition.ts";
import { workflowDeploymentConfiguration } from "./workflow-deployment.test-support.ts";

export async function sqliteWorkflowDeploymentFixture(
  t: TestContext,
  options: NonNullable<
    Parameters<typeof workflowDeploymentConfiguration>[0]
  > & { origin?: string } = {},
) {
  const directory = mkdtempSync(
    join(tmpdir(), "crewon-sqlite-workflow-deploy-"),
  );
  const databasePath = join(directory, "control.sqlite");
  const f = workflowDeploymentConfiguration(options);
  const owners: (() => void | Promise<unknown>)[] = [];
  t.after(async () => {
    const failures: unknown[] = [];
    for (const close of owners.reverse()) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    rmSync(directory, { recursive: true, force: true });
    if (failures.length)
      throw new AggregateError(failures, "sqlite_workflow_fixture_cleanup");
  });
  const activate = async (bootstrapOnly = false) =>
    activateStandaloneRuntimeAgentVersionRelease({
      ...f.runtimeConfig,
      ...(bootstrapOnly
        ? { additionalAgentVersions: [], agentVersionDeployments: [] }
        : {}),
      databasePath,
      actor: f.actor,
      authorization: f.authorization,
      clock: f.clock,
      activationId: bootstrapOnly ? "bootstrap-only" : "workflow-active",
    });
  await activate();
  const store = new SqliteRunStore(databasePath);
  owners.push(() => store.close());
  const database = new DatabaseSync(databasePath);
  owners.push(() => database.close());
  const token = "sqlite-workflow-fixture-session-with-32-bytes";
  const origin = options.origin ?? "http://127.0.0.1:5175";
  const control = async (
    workflow: WorkflowDeploymentConfiguration | null = f.workflow,
  ) => {
    const runtime = createStandaloneControlApi({
      databasePath,
      actor: f.actor,
      defaultAgentVersionId: f.base.route.agentVersionId,
      workflow: workflow ?? undefined,
      artifactStore: new InMemoryArtifactStore(),
      artifactEncryptionKeyId: "fixture-key",
      sessionToken: token,
      csrfToken: token,
      allowedOrigins: [origin],
      heartbeatIntervalMs: null,
      outboxScanIntervalMs: null,
      automationScanIntervalMs: null,
      artifactRetention: null,
    });
    owners.push(() => runtime.app.close());
    const baseUrl = await runtime.app.listen({ host: "127.0.0.1", port: 0 });
    return {
      runtime,
      baseUrl,
      client: new ControlApiClient({
        baseUrl,
        accessToken: token,
        csrfToken: token,
        origin,
      }),
    };
  };
  const worker = async (configuration = f.workflow, concurrency = 2) => {
    const tools = new InMemoryToolBroker();
    const config = { ...f.runtimeConfig, toolRuntime: tools };
    const runtime = await createStandaloneRuntimeWorker({
      ...config,
      databasePath,
      workflow: configuration,
      workerConcurrency: concurrency,
      agentVersionRuntimeFactory: sharedAgentVersionRuntimeFactory(
        config,
        tools,
      ),
    });
    owners.push(() => runtime.close());
    return runtime;
  };
  return {
    ...f,
    databasePath,
    store,
    database,
    control,
    worker,
    activate,
    token,
    origin,
  };
}
