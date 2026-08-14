import { createHash } from "node:crypto";

import {
  canonicalJson,
  type ModelProviderSetting,
  type ModelProviderSettingsCatalog,
  type ModelProviderSettingsStore,
  type PendingModelProviderSettings,
} from "@crewon/application";

const PREPARE_TTL_MS = 5 * 60 * 1_000;
const ACTOR = Object.freeze({
  principalId: "production-provider-catalog-bootstrap",
  actorId: "production-provider-catalog-bootstrap",
  spaceId: "production-provider-catalog",
});

export type ProductionProviderCatalogAuthority = Readonly<{
  tenantId: string;
  expectedRevision: number;
  runtimeBindingId: string;
  binding: ModelProviderSetting;
}>;

/**
 * Reconciles one frozen production Provider binding through the canonical
 * two-phase Store contract before the private Worker listener becomes ready.
 */
export async function bootstrapProductionProviderCatalog(
  store: ModelProviderSettingsStore,
  authority: ProductionProviderCatalogAuthority,
): Promise<ModelProviderSettingsCatalog> {
  const identity = mutationIdentity(authority);
  const initial = await store.loadModelProviderSettingsState({
    tenantId: authority.tenantId,
  });
  if (initial.pending !== null) {
    if (!pendingMatches(initial.pending, authority, identity.operationId)) {
      throw new Error("runtime_provider_catalog_pending_conflict");
    }
    return finalizeAndVerify(store, authority, identity);
  }
  if (initial.catalog !== null) {
    if (catalogMatches(initial.catalog, authority)) return initial.catalog;
    if (initial.catalog.revision !== authority.expectedRevision) {
      throw new Error("runtime_provider_catalog_revision_mismatch");
    }
  } else if (authority.expectedRevision !== 0) {
    throw new Error("runtime_provider_catalog_revision_mismatch");
  }

  const prepared = await store.prepareModelProviderSettings({
    tenantId: authority.tenantId,
    operationId: identity.operationId,
    coordinatorBinding: authority.runtimeBindingId,
    expectedRevision: authority.expectedRevision,
    activeProviderId: authority.binding.providerId,
    bindings: [authority.binding],
    ttlMs: PREPARE_TTL_MS,
    idempotencyKey: identity.prepareKey,
    fingerprint: fingerprint("prepare", authority),
    actor: ACTOR,
  });
  if (!pendingMatches(prepared.pending, authority, identity.operationId)) {
    throw new Error("runtime_provider_catalog_prepare_mismatch");
  }
  return finalizeAndVerify(store, authority, identity);
}

export function assertProductionProviderCatalogRoute(
  authority: ProductionProviderCatalogAuthority,
  route: Readonly<{ tenantId: string; runtimeBindingId: string }>,
): void {
  if (
    authority.tenantId !== route.tenantId ||
    authority.runtimeBindingId !== route.runtimeBindingId
  ) {
    throw new Error("runtime_provider_catalog_route_mismatch");
  }
}

async function finalizeAndVerify(
  store: ModelProviderSettingsStore,
  authority: ProductionProviderCatalogAuthority,
  identity: ReturnType<typeof mutationIdentity>,
): Promise<ModelProviderSettingsCatalog> {
  const finalized = await store.finalizeModelProviderSettings({
    tenantId: authority.tenantId,
    operationId: identity.operationId,
    coordinatorBinding: authority.runtimeBindingId,
    idempotencyKey: identity.finalizeKey,
    fingerprint: fingerprint("finalize", authority),
    actor: ACTOR,
  });
  if (!catalogMatches(finalized.catalog, authority)) {
    throw new Error("runtime_provider_catalog_finalize_mismatch");
  }
  const verified = await store.loadModelProviderSettingsState({
    tenantId: authority.tenantId,
  });
  if (
    verified.pending !== null ||
    verified.catalog === null ||
    !catalogMatches(verified.catalog, authority)
  ) {
    throw new Error("runtime_provider_catalog_verification_failed");
  }
  return verified.catalog;
}

function mutationIdentity(authority: ProductionProviderCatalogAuthority) {
  const digest = hash(canonicalJson(authority));
  return {
    operationId: `production-provider-catalog:${digest.slice("sha256:".length)}`,
    prepareKey: `prepare:${digest}`,
    finalizeKey: `finalize:${digest}`,
  };
}

function fingerprint(
  phase: "prepare" | "finalize",
  authority: ProductionProviderCatalogAuthority,
): string {
  return hash(canonicalJson({ phase, authority, actor: ACTOR }));
}

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function pendingMatches(
  pending: PendingModelProviderSettings,
  authority: ProductionProviderCatalogAuthority,
  operationId: string,
): boolean {
  return (
    pending.tenantId === authority.tenantId &&
    pending.operationId === operationId &&
    pending.coordinatorBinding === authority.runtimeBindingId &&
    pending.baseRevision === authority.expectedRevision &&
    pending.activeProviderId === authority.binding.providerId &&
    pending.runtimeBindingId === authority.runtimeBindingId &&
    canonicalJson(pending.bindings) === canonicalJson([authority.binding])
  );
}

function catalogMatches(
  catalog: ModelProviderSettingsCatalog,
  authority: ProductionProviderCatalogAuthority,
): boolean {
  return (
    catalog.tenantId === authority.tenantId &&
    catalog.revision === authority.expectedRevision + 1 &&
    catalog.activeProviderId === authority.binding.providerId &&
    catalog.runtimeBindingId === authority.runtimeBindingId &&
    canonicalJson(catalog.bindings) === canonicalJson([authority.binding])
  );
}
