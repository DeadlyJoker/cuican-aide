import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createProductionPostgresControlApi,
  type ProductionPostgresControlApiConfig,
} from "./production-composition.ts";

test("production composition rejects missing security authorities before opening PostgreSQL", async () => {
  const base = {
    connectionString: "not-a-postgres-connection",
    artifactStore: { close() {} },
    artifactEncryptionKeyId: "key-1",
  };
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      identity: null,
      authorization: {
        async authorize() {
          return { outcome: "allow" };
        },
      },
    } as unknown as ProductionPostgresControlApiConfig),
    /production_identity_required/u,
  );
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      identity: {
        async resolveActor() {
          throw new Error("unused");
        },
      },
      authorization: null,
    } as unknown as ProductionPostgresControlApiConfig),
    /production_authorization_required/u,
  );
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      identity: {
        async resolveActor() {
          throw new Error("unused");
        },
      },
      authorization: {
        async authorize() {
          return { outcome: "allow" };
        },
      },
    } as unknown as ProductionPostgresControlApiConfig),
    /production_provider_probe_registry_required/u,
  );
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      identity: {
        async resolveActor() {
          throw new Error("unused");
        },
      },
      authorization: {
        async authorize() {
          return { outcome: "allow" };
        },
      },
      providerProbeWorkers: {},
    } as unknown as ProductionPostgresControlApiConfig),
    /production_provider_probe_registry_invalid/u,
  );
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      identity: {
        async resolveActor() {
          throw new Error("unused");
        },
      },
      authorization: {
        async authorize() {
          return { outcome: "allow" };
        },
      },
      providerProbeWorkers: { resolve: () => null },
    } as unknown as ProductionPostgresControlApiConfig),
    /production_workspace_worker_registry_required/u,
  );
});

test("production composes Workflow commands from the single PostgreSQL Store", () => {
  const source = readFileSync(
    new URL("./production-composition.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /selectWorkflowRunStartFactory/u);
  assert.match(source, /new WorkflowRunApplicationService/u);
  assert.match(source, /new WorkflowHumanGateApplicationService/u);
  assert.match(source, /gatePublications: store/u);
  assert.match(source, /store\.listPublishedWorkflowHumanGates/u);
  assert.match(source, /await workflowVersionStore\.migrate\(\)/u);
});

test("production binds the required tenant Worker registry directly", () => {
  const source = readFileSync(
    new URL("./production-composition.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /new TenantRoutedProviderProbeWorker\(\s*config\.providerProbeWorkers,?\s*\)/u,
  );
  assert.match(source, /providerRuntimeAvailability: "available"/u);
  assert.doesNotMatch(source, /UnavailableTenantProviderProbeWorkerRegistry/u);
  assert.match(source, /new WorkspaceListApplicationService/u);
  assert.match(source, /workspaceLists,/u);
  assert.match(source, /workspaceReadonly: workspaceWorkers/u);
  assert.doesNotMatch(source, /workspaceLists: null/u);
  assert.doesNotMatch(source, /workspaceBindingId:\s*config\.workspaceWorker/u);
  assert.doesNotMatch(source, /LoopbackRuntimeWorkspaceWorkerClient/u);
});
