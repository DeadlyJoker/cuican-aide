import { validateModelTokenPrice, type ModelTokenPrice } from "@crewon/domain";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import type { AgentVersionStore } from "./agent-version-store-port.ts";
import type { ModelPricingStore } from "./model-pricing-store-port.ts";
import { ApplicationError } from "./application-error.ts";
import { RunStoreError } from "./run-store-port.ts";
export function parseModelPricingUpdate(value: unknown): {
  expectedRevision: number;
  price: ModelTokenPrice | null;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "expectedRevision,price"
  )
    throw new ApplicationError("validation", "model_pricing_request_invalid");
  const input = value as {
    expectedRevision: number;
    price: ModelTokenPrice | null;
  };
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  )
    throw new ApplicationError("validation", "model_pricing_revision_invalid");
  if (input.price !== null)
    try {
      validateModelTokenPrice(input.price);
    } catch {
      throw new ApplicationError("validation", "model_pricing_value_invalid");
    }
  return input;
}
/** Pricing changes are user/provider configuration, not model-context mutations. */
export class ModelPricingApplicationService {
  readonly dependencies: {
    store: AgentVersionStore & { readonly modelPricing?: ModelPricingStore };
    authorization: AuthorizationPort;
  };
  constructor(dependencies: ModelPricingApplicationService["dependencies"]) {
    this.dependencies = dependencies;
  }
  async #scope(
    actor: ActorContext,
    agentVersionId: string,
    action: "read" | "write",
  ) {
    for (const id of [
      actor.tenantId,
      actor.spaceId,
      actor.actorId,
      actor.principalId,
      agentVersionId,
    ])
      if (
        typeof id !== "string" ||
        !id.trim() ||
        id.length > 512 ||
        /[\u0000-\u001f]/u.test(id)
      )
        throw new ApplicationError(
          "validation",
          "model_pricing_locator_invalid",
        );
    for (const request of [
      {
        actor,
        action:
          action === "write"
            ? ("modelProviderSettings:write" as const)
            : ("modelProviderSettings:read" as const),
        resource: {
          kind: "modelProviderSettings" as const,
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
        },
      },
      {
        actor,
        action: "agentVersion:read" as const,
        resource: {
          kind: "agentVersion" as const,
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          agentVersionId,
        },
      },
    ]) {
      let decision;
      try {
        decision = await this.dependencies.authorization.authorize(request);
      } catch {
        throw new ApplicationError("internal", "authorization_failed");
      }
      if (decision.outcome !== "allow")
        throw new ApplicationError("authorization", "authorization_denied");
    }
    if (
      (await this.dependencies.store.loadAgentVersion({
        tenantId: actor.tenantId,
        agentVersionId,
      })) === null
    )
      throw new ApplicationError("notFound", "agent_version_not_found");
    const pricing = this.dependencies.store.modelPricing;
    if (pricing === undefined)
      throw new ApplicationError("internal", "model_pricing_unavailable");
    return pricing;
  }
  async get(actor: ActorContext, agentVersionId: string) {
    const store = await this.#scope(actor, agentVersionId, "read");
    try {
      return await store.get({ tenantId: actor.tenantId, agentVersionId });
    } catch (e) {
      throw map(e);
    }
  }
  async set(actor: ActorContext, agentVersionId: string, input: unknown) {
    const value = parseModelPricingUpdate(input),
      store = await this.#scope(actor, agentVersionId, "write");
    try {
      return await store.set({
        ...value,
        tenantId: actor.tenantId,
        agentVersionId,
      });
    } catch (e) {
      throw map(e);
    }
  }
}
function map(error: unknown): ApplicationError {
  return error instanceof RunStoreError &&
    error.code === "model_pricing_revision_conflict"
    ? new ApplicationError("conflict", error.code)
    : new ApplicationError("internal", "model_pricing_store_failed", {
        cause: error,
      });
}
