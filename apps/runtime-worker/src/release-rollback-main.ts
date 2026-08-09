import { v7 as uuidv7 } from "uuid";

import {
  rollbackPostgresRuntimeAgentVersionRelease,
  rollbackStandaloneRuntimeAgentVersionRelease,
} from "./agent-version-release-composition.ts";
import {
  loadRuntimeReleaseActor,
  RuntimeReleaseAuthorization,
} from "./release-authority.ts";
import { requiredEnvironment } from "./runtime-process-environment.ts";
import { SystemApplicationClock } from "./standalone-adapters.ts";

const actor = loadRuntimeReleaseActor();
const common = {
  actor,
  authorization: new RuntimeReleaseAuthorization(actor),
  clock: new SystemApplicationClock(),
  activationId:
    process.env.CREWON_AGENT_VERSION_ACTIVATION_ID?.trim() || uuidv7(),
  releaseId: requiredEnvironment("CREWON_AGENT_VERSION_ROLLBACK_RELEASE_ID"),
};
const connectionString = process.env.CREWON_CONTROL_DATABASE_URL?.trim();
const result = connectionString
  ? await rollbackPostgresRuntimeAgentVersionRelease({
      ...common,
      connectionString,
      ...(process.env.CREWON_CONTROL_DATABASE_SCHEMA?.trim()
        ? { schema: process.env.CREWON_CONTROL_DATABASE_SCHEMA.trim() }
        : {}),
    })
  : await rollbackStandaloneRuntimeAgentVersionRelease({
      ...common,
      databasePath: requiredEnvironment("CREWON_CONTROL_DB_PATH"),
    });

process.stdout.write(
  `${JSON.stringify({
    disposition: result.disposition,
    tenantId: actor.tenantId,
    releaseId: result.release.bundle.releaseId,
    activationId: result.release.activation.activationId,
    previousReleaseId: result.release.activation.previousReleaseId,
  })}\n`,
);
