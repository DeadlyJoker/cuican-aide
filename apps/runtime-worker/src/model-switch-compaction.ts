import type { ThreadModelState } from "@crewon/application";
import type {
  ContextCompactorPort,
  GovernedContextBundle,
  ModelContextProjection,
} from "@crewon/context";

export type CurrentModelRuntime = Readonly<{
  agentVersionId: string;
  adapterName: string;
  adapterVersion: string;
  modelId: string;
  contextWindowTokens: number;
  autoCompactAtTokens: number | null;
}>;

export type ModelSwitchCompactionDecision =
  | Readonly<{ required: false }>
  | Readonly<{
      required: true;
      replacesThroughSequence: number;
    }>;

export type PriorModelCompactionRuntime = Readonly<{
  compactor: ContextCompactorPort;
  governedContext?: GovernedContextBundle;
}>;

/** Resolves the immutable prior AgentVersion runtime used for switch compaction. */
export interface PriorModelCompactionResolverPort {
  resolve(
    prior: ThreadModelState,
  ):
    | PriorModelCompactionRuntime
    | null
    | Promise<PriorModelCompactionRuntime | null>;
}

export function decideModelSwitchCompaction(
  prior: ThreadModelState | null,
  current: CurrentModelRuntime,
  context: ModelContextProjection,
): ModelSwitchCompactionDecision {
  if (
    prior === null ||
    sameRuntime(prior, current) ||
    prior.contextWindowTokens <= current.contextWindowTokens ||
    current.autoCompactAtTokens === null ||
    (prior.latestUsage !== null &&
      prior.latestUsage.totalTokens < current.autoCompactAtTokens) ||
    prior.throughHistorySequence >= context.throughHistorySequence ||
    (context.compactedThroughSequence !== null &&
      context.compactedThroughSequence >= prior.throughHistorySequence)
  ) {
    return { required: false };
  }
  return {
    required: true,
    replacesThroughSequence: prior.throughHistorySequence,
  };
}

function sameRuntime(
  prior: ThreadModelState,
  current: CurrentModelRuntime,
): boolean {
  return (
    prior.agentVersionId === current.agentVersionId &&
    prior.adapterName === current.adapterName &&
    prior.adapterVersion === current.adapterVersion &&
    prior.modelId === current.modelId
  );
}
