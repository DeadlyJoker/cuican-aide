import { createStandaloneRuntimeWorker } from "../src/standalone-composition.ts";
import type { ModelTransportPort } from "@crewon/agent-kernel";

const runtime = await createStandaloneRuntimeWorker({
  databasePath: requiredEnvironment("CREWON_CONTROL_DB_PATH"),
  runtimeTenantId: "tenant-e2e-1",
  route: {
    authorityId: "standalone-e2e-1",
    runtimeGeneration: "ts-v0",
    agentVersionId: "agent-version-e2e-1",
    policySnapshotId: "policy-e2e-1",
    workspaceBindingId: "workspace-e2e-1",
  },
  transport: unusedDirectResponsesTransport(),
  ownerId: "crashing-worker",
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
