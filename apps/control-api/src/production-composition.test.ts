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
      providerProbeWorkers: {},
    } as unknown as ProductionPostgresControlApiConfig),
    /production_provider_probe_registry_invalid/u,
  );
});

test("production keeps Workflow commands disabled without cross-process certification", () => {
  const source = readFileSync(
    new URL("./production-composition.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /selectWorkflowRunStartFactory\(\{ status: "disabled" \}\)/u,
  );
  assert.doesNotMatch(source, /new WorkflowRunApplicationService/u);
  assert.match(source, /await workflowVersionStore\.migrate\(\)/u);
});
