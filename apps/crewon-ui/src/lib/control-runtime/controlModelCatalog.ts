import type {
  ActiveAgentVersionCatalogResponse,
  AgentVersionView,
} from "@crewon/contracts";

const MODEL_VARIANT_HASH = /^[a-f0-9]{24}$/u;
const MAX_CONTROL_MODELS = 24;

/** Returns the exact active AgentVersions generated for CrewON's model control. */
export function controlDefaultModelVersions(
  catalog: ActiveAgentVersionCatalogResponse,
): AgentVersionView[] {
  const defaults = catalog.data.filter(
    ({ agentVersionId }) => agentVersionId === catalog.defaultAgentVersionId,
  );
  if (defaults.length !== 1 || !defaults[0]?.model.modelId) {
    return [];
  }
  const defaultVersion = defaults[0];
  const seenModels = new Set([defaultVersion.model.modelId]);
  const versions = [defaultVersion];
  for (const candidate of catalog.data) {
    if (
      versions.length >= MAX_CONTROL_MODELS ||
      !isControlModelVariantOf(defaultVersion, candidate) ||
      !candidate.model.modelId ||
      seenModels.has(candidate.model.modelId)
    ) {
      continue;
    }
    seenModels.add(candidate.model.modelId);
    versions.push(candidate);
  }
  return versions;
}

/** Resolves a composer model to the immutable active AgentVersion that can run it. */
export function controlAgentVersionForModel(
  catalog: ActiveAgentVersionCatalogResponse,
  modelId: string | null | undefined,
): AgentVersionView {
  const versions = controlDefaultModelVersions(catalog);
  if (versions.length === 0) {
    throw new Error("control_agent_version_catalog_invalid");
  }
  if (modelId === null || modelId === undefined) {
    return versions[0]!;
  }
  const matches = versions.filter(
    (version) => version.model.modelId === modelId,
  );
  if (matches.length !== 1) {
    throw new Error("control_model_selection_mismatch");
  }
  return matches[0]!;
}

/** Model variants are composer choices, not separately recruitable Agents. */
export function isControlModelVariant(
  catalog: ActiveAgentVersionCatalogResponse,
  candidate: AgentVersionView,
): boolean {
  const defaultVersion = catalog.data.find(
    ({ agentVersionId }) => agentVersionId === catalog.defaultAgentVersionId,
  );
  return (
    defaultVersion !== undefined &&
    isControlModelVariantOf(defaultVersion, candidate)
  );
}

function isControlModelVariantOf(
  defaultVersion: AgentVersionView,
  candidate: AgentVersionView,
): boolean {
  const prefix = `${defaultVersion.agentVersionId}:model-`;
  return (
    candidate.agentVersionId.startsWith(prefix) &&
    MODEL_VARIANT_HASH.test(candidate.agentVersionId.slice(prefix.length)) &&
    candidate.runtimeGeneration === defaultVersion.runtimeGeneration &&
    candidate.policySnapshotId === defaultVersion.policySnapshotId &&
    candidate.model.adapterName === defaultVersion.model.adapterName &&
    candidate.model.adapterVersion === defaultVersion.model.adapterVersion
  );
}
