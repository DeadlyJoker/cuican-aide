import {
  parsePluginUiJsonValue,
  pluginUiFields,
  pluginUiFailure,
} from "./plugin-ui-json.ts";
import {
  parsePluginControlPackageDigest,
  parsePluginControlPluginId,
} from "./plugin-control-contract.ts";
import { pluginControlVersion } from "./plugin-control-contract-support.ts";
import {
  PROJECT_PLANNING_CAPABILITIES_VERSION,
  PROJECT_PLANNING_PROPOSAL_VERSION,
  PROJECT_PLANNING_MAX_BYTES,
  type ProjectPlanningCapability,
  type ProjectPlanningCapabilities,
  type ProjectPlanningProposalInput,
  type ProjectPlanningProposal,
} from "./project-planning-service.ts";
function invalid(): never {
  return pluginUiFailure("project_planning_data_invalid");
}
function text(input: unknown, limit: number, multiline = false): string {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    new TextEncoder().encode(input).byteLength > limit ||
    (multiline
      ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
      : /[\u0000-\u001f\u007f]/u
    ).test(input)
  )
    invalid();
  return input;
}
function digest(input: unknown): string {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input))
    invalid();
  return input;
}
function fields(input: unknown, keys: readonly string[]) {
  return pluginUiFields(
    parsePluginUiJsonValue(input, { maxBytes: PROJECT_PLANNING_MAX_BYTES }),
    keys,
  );
}
export function parseProjectPlanningCapability(
  input: unknown,
): ProjectPlanningCapability {
  const v = fields(input, [
    "capabilityId",
    "source",
    "title",
    "kind",
    "stages",
    "maximumEpisodes",
    "moduleAvailable",
    "textPlansAvailable",
    "executionReady",
  ]);
  const source = pluginUiFields(v.source, [
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
    "contributionId",
  ]);
  if (
    v.kind !== "short-drama" ||
    v.maximumEpisodes !== 16 ||
    !Array.isArray(v.stages) ||
    JSON.stringify(v.stages) !== '["brief","outline","script"]' ||
    [v.moduleAvailable, v.textPlansAvailable, v.executionReady].some(
      (x) => typeof x !== "boolean",
    )
  )
    invalid();
  if (
    v.executionReady === true &&
    (v.moduleAvailable !== true || v.textPlansAvailable !== true)
  )
    invalid();
  return Object.freeze({
    capabilityId: digest(v.capabilityId),
    source: Object.freeze({
      pluginId: parsePluginControlPluginId(source.pluginId),
      publisherId: parsePluginControlPluginId(source.publisherId),
      version: pluginControlVersion(source.version),
      packageDigest: parsePluginControlPackageDigest(source.packageDigest),
      contributionId: parsePluginControlPluginId(source.contributionId),
    }),
    title: text(v.title, 256),
    kind: "short-drama",
    stages: Object.freeze(["brief", "outline", "script"] as const),
    maximumEpisodes: 16,
    moduleAvailable: v.moduleAvailable as boolean,
    textPlansAvailable: v.textPlansAvailable as boolean,
    executionReady: v.executionReady as boolean,
  });
}
export function parseProjectPlanningCapabilities(
  input: unknown,
): ProjectPlanningCapabilities {
  const v = fields(input, ["schemaVersion", "capabilities"]);
  if (
    v.schemaVersion !== PROJECT_PLANNING_CAPABILITIES_VERSION ||
    !Array.isArray(v.capabilities) ||
    v.capabilities.length > 8
  )
    invalid();
  const capabilities = v.capabilities.map(parseProjectPlanningCapability);
  if (
    new Set(capabilities.map((x) => x.capabilityId)).size !==
    capabilities.length
  )
    invalid();
  return Object.freeze({
    schemaVersion: PROJECT_PLANNING_CAPABILITIES_VERSION,
    capabilities: Object.freeze(capabilities),
  });
}
export function parseProjectPlanningProposalInput(
  input: unknown,
): ProjectPlanningProposalInput {
  const v = fields(input, [
    "capabilityId",
    "title",
    "briefText",
    "instruction",
    "start",
    "target",
    "episodeCount",
    "adoption",
  ]);
  if (
    (v.start !== "brief" && v.start !== "outline") ||
    !["brief", "outline", "script"].includes(v.target as string) ||
    (v.adoption !== "manual" && v.adoption !== "whenUnchanged") ||
    (v.start === "outline" && v.target === "brief")
  )
    invalid();
  if (
    v.target === "brief"
      ? v.episodeCount !== null
      : typeof v.episodeCount !== "number" ||
        !Number.isSafeInteger(v.episodeCount) ||
        v.episodeCount < 1 ||
        v.episodeCount > 16
  )
    invalid();
  return Object.freeze({
    capabilityId: digest(v.capabilityId),
    title: text(v.title, 128),
    briefText: text(v.briefText, 4096, true),
    instruction: text(v.instruction, 2048, true),
    start: v.start as ProjectPlanningProposalInput["start"],
    target: v.target as ProjectPlanningProposalInput["target"],
    episodeCount: v.episodeCount as number | null,
    adoption: v.adoption as ProjectPlanningProposalInput["adoption"],
  });
}
export function parseProjectPlanningProposal(
  input: unknown,
): ProjectPlanningProposal {
  const v = fields(input, [
    "schemaVersion",
    "kind",
    "capability",
    "origin",
    "input",
  ]);
  if (
    v.schemaVersion !== PROJECT_PLANNING_PROPOSAL_VERSION ||
    v.kind !== "newProject"
  )
    invalid();
  const capability = parseProjectPlanningCapability(v.capability),
    proposal = parseProjectPlanningProposalInput(v.input),
    origin = pluginUiFields(v.origin, ["runId", "threadId", "callId"]);
  if (capability.capabilityId !== proposal.capabilityId) invalid();
  return Object.freeze({
    schemaVersion: PROJECT_PLANNING_PROPOSAL_VERSION,
    kind: "newProject",
    capability,
    origin: Object.freeze({
      runId: text(origin.runId, 256),
      threadId: text(origin.threadId, 256),
      callId: text(origin.callId, 256),
    }),
    input: proposal,
  });
}
