import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  captureProjectGenerationExecutionPublication,
  type ProjectGenerationExecutionPublication,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parsePluginTaskAdmissionPin,
  type PluginTaskAdmission,
} from "@crewon/domain";
import {
  admitPostgresPluginTaskPin,
  admitSqlitePluginTaskPin,
} from "./plugin-task-admission-store-support.ts";

/** Qualification remains private and detached; no source admission is invented for the execution Run. */
export function captureProjectGenerationPublicationAdmission(
  input: ProjectGenerationExecutionPublication,
  admission: PluginTaskAdmission,
): ProjectGenerationExecutionPublication {
  const publication = captureProjectGenerationExecutionPublication(input);
  const {
    schemaVersion: _schema,
    runId: _run,
    threadId: _thread,
    extensionBindingDigest: _binding,
    requestDigest: _receipt,
    idempotencyKey: _key,
    ...rawPin
  } = admission;
  const pin = parsePluginTaskAdmissionPin(rawPin);
  if (
    extensionCanonicalJson(pin) !==
    extensionCanonicalJson(publication.executionPin)
  )
    throw new Error("project_generation_execution_admission_mismatch");
  return publication;
}

function orderedPins(publication: ProjectGenerationExecutionPublication) {
  const key = (pin: typeof publication.sourcePin) =>
    JSON.stringify([pin.tenantId, pin.spaceId, pin.profileId, pin.pluginId]);
  return [publication.sourcePin, publication.executionPin].sort(
    (left, right) =>
      key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0,
  );
}

/** Both actual records share the transaction's existing client; selection updates wait until COMMIT. */
export async function admitPostgresProjectGenerationPublication(
  client: PoolClient,
  schema: string,
  publication: ProjectGenerationExecutionPublication,
): Promise<void> {
  for (const pin of orderedPins(publication))
    await admitPostgresPluginTaskPin(client, schema, pin);
}

export function admitSqliteProjectGenerationPublication(
  database: DatabaseSync,
  publication: ProjectGenerationExecutionPublication,
): void {
  for (const pin of orderedPins(publication))
    admitSqlitePluginTaskPin(database, pin);
}
