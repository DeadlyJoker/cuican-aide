import type { ModelTransportPort } from "@crewon/agent-kernel";

import { createPostgresRuntimeWorker } from "../src/standalone-composition.ts";

const runtime = await createPostgresRuntimeWorker({
  connectionString: requiredEnvironment("CREWON_CONTROL_DATABASE_URL"),
  schema: requiredEnvironment("CREWON_CONTROL_DATABASE_SCHEMA"),
  runtimeTenantId: requiredEnvironment("CREWON_TENANT_ID"),
  route: {
    authorityId: requiredEnvironment("CREWON_AUTHORITY_ID"),
    runtimeGeneration: requiredEnvironment("CREWON_RUNTIME_GENERATION"),
    agentVersionId: requiredEnvironment("CREWON_AGENT_VERSION_ID"),
    policySnapshotId: requiredEnvironment("CREWON_POLICY_SNAPSHOT_ID"),
    workspaceBindingId: requiredEnvironment("CREWON_WORKSPACE_BINDING_ID"),
  },
  transport: unusedDirectResponsesTransport(),
  ownerId: "postgres-crashing-worker",
  leaseDurationMs: 30_000,
  retryAfterMs: 0,
  scanIntervalMs: null,
  afterAttemptStarted: async () => {
    process.stdout.write("attempt-started-before-crash\n");
    await new Promise<void>(() => {
      // The parent test sends SIGKILL after observing the durable checkpoint.
    });
  },
});

await runtime.worker.wake();
throw new Error("crash fixture did not terminate");

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name}_required`);
  }
  return value;
}

function unusedDirectResponsesTransport(): ModelTransportPort {
  return {
    adapterName: "direct-responses",
    adapterVersion: "1",
    modelId: "fake-model",
    async *stream() {
      throw new Error("crash_fixture_stream_unreachable");
    },
  };
}
