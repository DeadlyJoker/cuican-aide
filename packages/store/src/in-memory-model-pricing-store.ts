import {
  modelPricingSnapshot,
  type ModelPricingLocator,
  type ModelPricingStore,
  type ModelPricingState,
  type SetModelPricingInput,
} from "@crewon/application";
import {
  EMPTY_MODEL_PRICING,
  nextModelPricing,
  validateModelPricingLocator,
} from "./model-pricing-store-support.ts";
export class InMemoryModelPricingStore implements ModelPricingStore {
  readonly #values = new Map<string, ModelPricingState>();
  #key(input: ModelPricingLocator) {
    validateModelPricingLocator(input);
    return JSON.stringify([input.tenantId, input.agentVersionId]);
  }
  snapshot(input: ModelPricingLocator) {
    return modelPricingSnapshot(
      structuredClone(
        this.#values.get(this.#key(input)) ?? EMPTY_MODEL_PRICING,
      ),
    );
  }
  async get(input: ModelPricingLocator) {
    return structuredClone(
      this.#values.get(this.#key(input)) ?? EMPTY_MODEL_PRICING,
    );
  }
  async set(input: SetModelPricingInput) {
    const key = this.#key(input),
      before = this.#values.get(key) ?? EMPTY_MODEL_PRICING,
      next = nextModelPricing(before, input);
    if (next !== before) this.#values.set(key, structuredClone(next));
    return structuredClone(next);
  }
}
