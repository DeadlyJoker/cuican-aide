import { createHash } from "node:crypto";
import { createExtensionConfiguration } from "@crewon/domain";
import {
  INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
  parseInstalledPluginPeerRequest,
  type InstalledPluginPeerPrepareCandidateRequest,
} from "@crewon/contracts/plugins";
import {
  InstalledPluginPeerError,
  type InstalledPluginPeerCandidatePreparationInput,
} from "./installed-plugin-peer-client.ts";

// Private-wire fixtures only: no installed package, authority, admission or funds are supplied here.
export const candidateDigester = {
  sha256: (input: string) =>
    `sha256:${createHash("sha256").update(input).digest("hex")}`,
};
export const candidateActor = {
  principalId: "candidate-principal",
  actorId: "candidate-actor",
  tenantId: "candidate-tenant",
  spaceId: "candidate-space",
};
export const candidateScope = {
  tenantId: candidateActor.tenantId,
  spaceId: candidateActor.spaceId,
  profileId: "candidate-profile",
};
export const candidateIdentity = {
  pluginId: "crewon.krea2",
  publisherId: "crewon",
  version: "1.0.0",
  packageDigest: candidateDigester.sha256("candidate package fixture"),
  manifestDigest: candidateDigester.sha256("candidate manifest fixture"),
  implementationDigest: candidateDigester.sha256(
    "candidate implementation fixture",
  ),
};
export const candidateConfiguration = createExtensionConfiguration(
  {
    schemaVersion: "crewon.extension-configuration.v0",
    tenantId: candidateActor.tenantId,
    spaceId: candidateActor.spaceId,
    pluginId: candidateIdentity.pluginId,
    revision: 2,
    pluginVersion: candidateIdentity.version,
    manifestDigest: candidateIdentity.manifestDigest,
    implementationDigest: candidateIdentity.implementationDigest,
    parameters: { endpoint: "https://candidate-fixture.example" },
    credentialBindings: [],
    createdByActorId: candidateActor.actorId,
    createdAt: "2026-10-03T00:00:00.000Z",
  },
  candidateDigester,
);
export const candidateTarget = {
  executionAuthority: "crewonKernel" as const,
  agentVersionId: "candidate-agent",
  agentVersionContentDigest: candidateDigester.sha256(
    "candidate agent fixture",
  ),
  materializationDigest: candidateDigester.sha256(
    "candidate materialization fixture",
  ),
  authorityId: "candidate-authority",
  runtimeGeneration: "candidate-generation",
  policySnapshotId: "candidate-policy",
  workspaceBindingId: null,
};
export const candidateInput: InstalledPluginPeerCandidatePreparationInput = {
  actor: candidateActor,
  scope: candidateScope,
  identity: candidateIdentity,
  configuration: candidateConfiguration,
  expectedTarget: candidateTarget,
  expectedSelectionRevision: 4,
};
export const candidateTransportConfiguration = {
  origin: "http://127.0.0.1:3217",
  token: "candidate-private-peer-test-token-32-bytes",
};
export function candidateRequest(
  init?: RequestInit,
): InstalledPluginPeerPrepareCandidateRequest {
  const request = parseInstalledPluginPeerRequest(
    JSON.parse(String(init?.body)),
  );
  if (request.operation !== "prepareCandidate")
    throw new Error("candidate_fixture_unexpected_operation");
  return request;
}
export function candidateResponse(
  request: InstalledPluginPeerPrepareCandidateRequest,
): Record<string, unknown> {
  return {
    protocol: INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
    requestId: request.requestId,
    operation: request.operation,
    actor: request.actor,
    scope: request.scope,
    identity: request.identity,
    configurationDigest: candidateConfiguration.contentDigest,
    expectedTarget: request.expectedTarget,
    expectedSelectionRevision: request.expectedSelectionRevision,
    result: { outcome: "ready", target: request.expectedTarget },
  };
}
export function candidateError(code: string) {
  return (error: unknown) =>
    error instanceof InstalledPluginPeerError &&
    error.code === `installed_plugin_peer_${code}`;
}
export function candidateDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
