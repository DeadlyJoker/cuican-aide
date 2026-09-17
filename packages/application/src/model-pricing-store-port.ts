import type {
  ModelTokenPrice,
  ModelTokenPricingSnapshot,
} from "@crewon/domain";
export type ModelPricingLocator = Readonly<{
  tenantId: string;
  agentVersionId: string;
}>;
export type ModelPricingState = Readonly<{
  revision: number;
  price: ModelTokenPrice | null;
}>;
export type SetModelPricingInput = ModelPricingLocator &
  Readonly<{ expectedRevision: number; price: ModelTokenPrice | null }>;
/** Tenant/AgentVersion scoped prices, separate from model-visible configuration. */
export interface ModelPricingStore {
  get(input: ModelPricingLocator): Promise<ModelPricingState>;
  set(input: SetModelPricingInput): Promise<ModelPricingState>;
}
export function modelPricingSnapshot(
  state: ModelPricingState,
): ModelTokenPricingSnapshot | undefined {
  return state.price === null
    ? undefined
    : { revision: state.revision, price: state.price };
}
