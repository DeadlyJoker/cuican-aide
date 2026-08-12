import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { SqliteRunStore } from "@crewon/store";

const databasePath = requiredEnvironment("CREWON_CONTROL_DB_PATH");
const tenantId = process.env.CREWON_TENANT_ID?.trim() || "standalone-tenant";
const input = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>;

const store = new SqliteRunStore(databasePath);
try {
  const actor = {
    principalId: "desktop-provider-coordinator",
    actorId: "desktop-provider-coordinator",
    spaceId: process.env.CREWON_SPACE_ID?.trim() || "standalone-space",
  };
  const operationId = String(input.operationId ?? "");
  const receipt = {
    tenantId,
    operationId,
    idempotencyKey: `${String(input.phase)}:${operationId}`,
    fingerprint: `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`,
    actor,
  };
  let disposition: string | null = null;
  if (input.phase === "prepare") {
    const result = await store.prepareModelProviderSettings({
      ...receipt,
      coordinatorBinding: String(input.runtimeBindingId),
      expectedRevision: Number(input.expectedRevision),
      activeProviderId: input.activeProviderId === null ? null : String(input.activeProviderId),
      bindings: input.bindings as never,
      ttlMs: Number(input.ttlMs),
    });
    disposition = result.disposition;
  } else if (input.phase === "finalize") {
    const result = await store.finalizeModelProviderSettings({
      ...receipt,
      coordinatorBinding: String(input.runtimeBindingId),
    });
    disposition = result.disposition;
  } else if (input.phase === "abort") {
    const result = await store.abortModelProviderSettings({
      ...receipt,
      coordinatorBinding: String(input.runtimeBindingId),
    });
    disposition = result.disposition;
  } else if (input.phase === "recover") {
    const result = await store.expireModelProviderSettings({
      ...receipt,
      recoveryBinding: String(input.recoveryBinding),
    });
    disposition = result.disposition;
  } else if (input.phase !== "inspect") {
    throw new Error("provider_settings_coordinator_phase_unsupported");
  }
  const state = await store.loadModelProviderSettingsState({ tenantId });
  process.stdout.write(`${JSON.stringify({
    phase: input.phase,
    disposition,
    catalog: state.catalog === null ? null : projectCatalog(state.catalog),
    pending: state.pending === null ? null : projectPending(state.pending),
  })}\n`);
} finally {
  await store.close();
}

function projectCatalog(catalog: { revision: number; activeProviderId: string | null; runtimeBindingId: string | null }) {
  return { revision: catalog.revision, activeProviderId: catalog.activeProviderId,
    runtimeBindingId: catalog.runtimeBindingId };
}

function projectPending(pending: { operationId: string; baseRevision: number;
  runtimeBindingId: string | null; expiresAt: string }) {
  return { operationId: pending.operationId, baseRevision: pending.baseRevision,
    runtimeBindingId: pending.runtimeBindingId, expiresAt: pending.expiresAt };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}
