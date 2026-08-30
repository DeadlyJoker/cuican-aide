import {
  RunStoreError,
  type AgentVersionAsset,
  type AgentVersionDeployment,
  type AgentVersionDeploymentCandidate,
  type AgentVersionReleaseActivation,
  type AgentVersionReleaseBundle,
} from "@crewon/application";

import { stableJson } from "./store-invariants.ts";

const MAX_DEFINITION_BYTES = 1024 * 1024;
const MAX_RELEASE_DEPLOYMENTS = 1_000;

export function validateAgentVersionAsset(asset: AgentVersionAsset): void {
  if (
    !isPlainObject(asset) ||
    asset.schemaVersion !== "crewon.agent-version-asset.v0"
  ) {
    throw new RunStoreError("agent_version_asset_invalid");
  }
  requireBounded(asset.tenantId, 256, "agent_version_tenant_invalid");
  requireBounded(asset.agentVersionId, 512, "agent_version_id_invalid");
  if (!/^sha256:[a-f0-9]{64}$/u.test(asset.contentDigest)) {
    throw new RunStoreError("agent_version_digest_invalid");
  }
  if (
    typeof asset.definitionJson !== "string" ||
    new TextEncoder().encode(asset.definitionJson).byteLength >
      MAX_DEFINITION_BYTES
  ) {
    throw new RunStoreError("agent_version_definition_invalid");
  }
  try {
    if (!isPlainObject(JSON.parse(asset.definitionJson))) {
      throw new Error("definition_not_object");
    }
  } catch (error) {
    throw new RunStoreError("agent_version_definition_invalid", {
      cause: error,
    });
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(
      asset.createdAt,
    ) ||
    Number.isNaN(Date.parse(asset.createdAt))
  ) {
    throw new RunStoreError("agent_version_created_at_invalid");
  }
}

export function validateAgentVersionLocator(input: {
  tenantId: string;
  agentVersionId: string;
}): void {
  requireBounded(input.tenantId, 256, "agent_version_tenant_invalid");
  requireBounded(input.agentVersionId, 512, "agent_version_id_invalid");
}

export function validateAgentVersionList(input: {
  tenantId: string;
  afterAgentVersionId: string | null;
  limit: number;
}): void {
  requireBounded(input.tenantId, 256, "agent_version_tenant_invalid");
  if (input.afterAgentVersionId !== null) {
    requireBounded(
      input.afterAgentVersionId,
      512,
      "agent_version_cursor_invalid",
    );
  }
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 1000
  ) {
    throw new RunStoreError("agent_version_limit_invalid");
  }
}

export function sameAgentVersionAsset(
  left: AgentVersionAsset,
  right: AgentVersionAsset,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.agentVersionId === right.agentVersionId &&
    left.contentDigest === right.contentDigest &&
    left.definitionJson === right.definitionJson
  );
}

export function validateAgentVersionDeployment(
  deployment: AgentVersionDeployment,
): void {
  if (
    !isPlainObject(deployment) ||
    deployment.schemaVersion !== "crewon.agent-version-deployment.v0" ||
    !hasExactKeys(deployment, [
      "agentVersionId",
      "authorityId",
      "contentDigest",
      "deployedAt",
      "materializationDigest",
      "schemaVersion",
      "tenantId",
      "workspaceBindingId",
    ])
  ) {
    throw new RunStoreError("agent_version_deployment_invalid");
  }
  validateAgentVersionLocator(deployment);
  requireDigest(deployment.contentDigest, "agent_version_digest_invalid");
  requireDigest(
    deployment.materializationDigest,
    "agent_version_materialization_digest_invalid",
  );
  requireBounded(
    deployment.authorityId,
    512,
    "agent_version_deployment_authority_invalid",
  );
  if (deployment.workspaceBindingId !== null) {
    requireBounded(
      deployment.workspaceBindingId,
      512,
      "agent_version_deployment_workspace_invalid",
    );
  }
  requireTimestamp(deployment.deployedAt, "agent_version_deployed_at_invalid");
}

export function validateAgentVersionReleaseBundle(
  bundle: AgentVersionReleaseBundle,
): void {
  if (
    !isPlainObject(bundle) ||
    bundle.schemaVersion !== "crewon.agent-version-release-bundle.v0" ||
    !hasExactKeys(bundle, [
      "defaultAgentVersionId",
      "deployments",
      "manifestDigest",
      "releaseId",
      "schemaVersion",
      "tenantId",
    ]) ||
    !Array.isArray(bundle.deployments) ||
    bundle.deployments.length === 0 ||
    bundle.deployments.length > MAX_RELEASE_DEPLOYMENTS
  ) {
    throw new RunStoreError("agent_version_release_bundle_invalid");
  }
  requireBounded(bundle.tenantId, 256, "agent_version_tenant_invalid");
  requireDigest(bundle.releaseId, "agent_version_release_id_invalid");
  requireDigest(
    bundle.manifestDigest,
    "agent_version_release_manifest_digest_invalid",
  );
  if (bundle.releaseId !== bundle.manifestDigest) {
    throw new RunStoreError("agent_version_release_manifest_invalid");
  }
  requireBounded(
    bundle.defaultAgentVersionId,
    512,
    "agent_version_release_default_invalid",
  );
  const versions = new Set<string>();
  for (const deployment of bundle.deployments) {
    validateAgentVersionDeploymentCandidate(deployment);
    if (deployment.tenantId !== bundle.tenantId) {
      throw new RunStoreError("agent_version_release_tenant_mismatch");
    }
    if (versions.has(deployment.agentVersionId)) {
      throw new RunStoreError("agent_version_release_duplicate_version");
    }
    versions.add(deployment.agentVersionId);
  }
  if (!versions.has(bundle.defaultAgentVersionId)) {
    throw new RunStoreError("agent_version_release_default_missing");
  }
}

export function validateAgentVersionReleaseActivation(
  activation: AgentVersionReleaseActivation,
): void {
  if (
    !isPlainObject(activation) ||
    activation.schemaVersion !== "crewon.agent-version-release-activation.v0" ||
    !hasExactKeys(activation, [
      "activatedAt",
      "activationId",
      "operator",
      "previousReleaseId",
      "releaseId",
      "schemaVersion",
      "tenantId",
    ]) ||
    !isPlainObject(activation.operator) ||
    !hasExactKeys(activation.operator, ["actorId", "principalId", "spaceId"])
  ) {
    throw new RunStoreError("agent_version_release_activation_invalid");
  }
  requireBounded(activation.tenantId, 256, "agent_version_tenant_invalid");
  requireDigest(activation.releaseId, "agent_version_release_id_invalid");
  requireBounded(
    activation.activationId,
    512,
    "agent_version_release_activation_id_invalid",
  );
  if (activation.previousReleaseId !== null) {
    requireDigest(
      activation.previousReleaseId,
      "agent_version_release_previous_id_invalid",
    );
  }
  requireBounded(
    activation.operator.principalId,
    512,
    "agent_version_release_operator_invalid",
  );
  requireBounded(
    activation.operator.actorId,
    512,
    "agent_version_release_operator_invalid",
  );
  requireBounded(
    activation.operator.spaceId,
    512,
    "agent_version_release_operator_invalid",
  );
  requireTimestamp(
    activation.activatedAt,
    "agent_version_release_activated_at_invalid",
  );
}

export function validateAgentVersionReleaseLocator(input: {
  tenantId: string;
  releaseId: string;
}): void {
  requireBounded(input.tenantId, 256, "agent_version_tenant_invalid");
  requireDigest(input.releaseId, "agent_version_release_id_invalid");
}

export function validateAgentVersionReleaseTenant(input: {
  tenantId: string;
}): void {
  requireBounded(input.tenantId, 256, "agent_version_tenant_invalid");
}

export function validateAgentVersionReleaseActivationLocator(input: {
  tenantId: string;
  activationId: string;
}): void {
  requireBounded(input.tenantId, 256, "agent_version_tenant_invalid");
  requireBounded(
    input.activationId,
    512,
    "agent_version_release_activation_id_invalid",
  );
}

export function sameAgentVersionReleaseBundle(
  left: AgentVersionReleaseBundle,
  right: AgentVersionReleaseBundle,
): boolean {
  return stableJson(left) === stableJson(right);
}

export function sameAgentVersionReleaseActivation(
  left: AgentVersionReleaseActivation,
  right: AgentVersionReleaseActivation,
): boolean {
  return stableJson(left) === stableJson(right);
}

export function sameAgentVersionDeploymentCandidate(
  left: AgentVersionDeployment | AgentVersionDeploymentCandidate,
  right: AgentVersionDeploymentCandidate,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.agentVersionId === right.agentVersionId &&
    left.contentDigest === right.contentDigest &&
    left.materializationDigest === right.materializationDigest &&
    left.authorityId === right.authorityId &&
    left.workspaceBindingId === right.workspaceBindingId
  );
}

function validateAgentVersionDeploymentCandidate(
  deployment: AgentVersionDeploymentCandidate,
): void {
  if (
    !isPlainObject(deployment) ||
    deployment.schemaVersion !== "crewon.agent-version-deployment.v0" ||
    !hasExactKeys(deployment, [
      "agentVersionId",
      "authorityId",
      "contentDigest",
      "materializationDigest",
      "schemaVersion",
      "tenantId",
      "workspaceBindingId",
    ])
  ) {
    throw new RunStoreError("agent_version_deployment_invalid");
  }
  validateAgentVersionLocator(deployment);
  requireDigest(deployment.contentDigest, "agent_version_digest_invalid");
  requireDigest(
    deployment.materializationDigest,
    "agent_version_materialization_digest_invalid",
  );
  requireBounded(
    deployment.authorityId,
    512,
    "agent_version_deployment_authority_invalid",
  );
  if (deployment.workspaceBindingId !== null) {
    requireBounded(
      deployment.workspaceBindingId,
      512,
      "agent_version_deployment_workspace_invalid",
    );
  }
}

function requireDigest(value: unknown, code: string): void {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new RunStoreError(code);
  }
}

function requireTimestamp(value: unknown, code: string): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new RunStoreError(code);
  }
}

function requireBounded(value: unknown, max: number, code: string): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max
  ) {
    throw new RunStoreError(code);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}
