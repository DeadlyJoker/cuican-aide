import { isDeepStrictEqual } from "node:util";
import type { CompiledAgentVersion } from "@crewon/agent-version";
import type { AgentVersionDeploymentCandidate } from "@crewon/application";
import {
  agentVersionDeploymentCandidates,
  parseRuntimeBindingConfig,
  type RuntimeBindingConfig,
} from "../runtime-binding-config.ts";
import {
  assertLoadedInstalledPluginRelease,
  type LoadedInstalledPluginRelease,
} from "./installed-plugin-release-loader.ts";
import type { RuntimeAgentVersionReleasePlan } from "../agent-version-release.ts";

function fail(): never {
  throw new Error("installed_plugin_release_publication_input_conflict");
}

/** Only a manifest that this CLI will actually publish can add an original source binding. */
export function mergeInstalledPluginReleasePublicationInput(
  input: Readonly<{
    release: LoadedInstalledPluginRelease;
    existingVersions: readonly CompiledAgentVersion[];
    existingDeployments: readonly AgentVersionDeploymentCandidate[];
    generatedBindings?: RuntimeBindingConfig;
  }>,
) {
  assertLoadedInstalledPluginRelease(input.release);
  const { tenantId, defaultAgentVersionId } = input.release.document;
  let generatedBindings: RuntimeBindingConfig | undefined;
  if (input.generatedBindings !== undefined) {
    const original = parseRuntimeBindingConfig(input.generatedBindings);
    const bindings = [...original.bindings];
    for (const entry of input.release.document.entries) {
      const source = entry.modelSource.runtimeBinding;
      const prior = bindings.find(
        (binding) =>
          binding.tenantId === source.tenantId &&
          binding.agentVersionId === source.agentVersionId,
      );
      if (prior === undefined) bindings.push(source);
      else if (!isDeepStrictEqual(prior, source)) fail();
    }
    generatedBindings = freeze(
      parseRuntimeBindingConfig({
        schemaVersion: original.schemaVersion,
        bindings,
      }),
    );
  }
  const existingDeployments =
    generatedBindings === undefined
      ? input.existingDeployments
      : agentVersionDeploymentCandidates(generatedBindings).filter(
          (deployment) =>
            deployment.tenantId === tenantId &&
            deployment.agentVersionId !== defaultAgentVersionId,
        );
  const deploymentIds = new Set<string>();
  for (const deployment of existingDeployments) {
    if (
      deployment.tenantId !== tenantId ||
      deploymentIds.has(deployment.agentVersionId)
    )
      fail();
    deploymentIds.add(deployment.agentVersionId);
  }
  for (const entry of input.release.document.entries) {
    const source = entry.modelSource.deployment;
    // The publication owner checks the unchanged static bootstrap candidate in the final plan.
    if (source.agentVersionId === defaultAgentVersionId) continue;
    const actual = existingDeployments.find(
      (candidate) => candidate.agentVersionId === source.agentVersionId,
    );
    if (actual === undefined || !isDeepStrictEqual(actual, source)) fail();
  }
  const additionalAgentVersions = [
    ...input.existingVersions,
    ...input.release.versions,
  ];
  const versionIds = new Set<string>();
  for (const version of additionalAgentVersions) {
    if (
      version.agentVersionId === defaultAgentVersionId ||
      versionIds.has(version.agentVersionId)
    )
      fail();
    versionIds.add(version.agentVersionId);
  }
  const agentVersionDeployments = [...existingDeployments];
  for (const deployment of input.release.deployments) {
    if (deploymentIds.has(deployment.agentVersionId)) fail();
    deploymentIds.add(deployment.agentVersionId);
    agentVersionDeployments.push(deployment);
  }
  return Object.freeze({
    additionalAgentVersions: Object.freeze(additionalAgentVersions),
    agentVersionDeployments: Object.freeze(agentVersionDeployments),
    ...(generatedBindings === undefined ? {} : { generatedBindings }),
  });
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A generated manifest must describe the exact ordinary factory candidates that main will load. */
export function captureInstalledPluginPublicationBindings(
  input: Readonly<{
    config: RuntimeBindingConfig;
    release: LoadedInstalledPluginRelease;
    runtimePlan: RuntimeAgentVersionReleasePlan;
  }>,
): RuntimeBindingConfig {
  assertLoadedInstalledPluginRelease(input.release);
  const config = parseRuntimeBindingConfig(input.config);
  const derived = new Set(
    input.release.deployments.map((entry) => entry.agentVersionId),
  );
  const expected = input.runtimePlan.deployments.filter(
    (entry) =>
      entry.agentVersionId !== input.runtimePlan.bundle.defaultAgentVersionId &&
      !derived.has(entry.agentVersionId),
  );
  const candidates = agentVersionDeploymentCandidates(config);
  if (
    candidates.some(
      (entry) =>
        entry.tenantId !== input.runtimePlan.bundle.tenantId ||
        derived.has(entry.agentVersionId),
    )
  )
    fail();
  const actual = candidates.filter(
    (entry) =>
      entry.agentVersionId !== input.runtimePlan.bundle.defaultAgentVersionId,
  );
  if (
    actual.length !== expected.length ||
    new Set(actual.map((entry) => entry.agentVersionId)).size !==
      actual.length ||
    expected.some(
      (entry) =>
        !isDeepStrictEqual(
          entry,
          actual.find(
            (candidate) => candidate.agentVersionId === entry.agentVersionId,
          ),
        ),
    )
  )
    fail();
  return freeze(config);
}
