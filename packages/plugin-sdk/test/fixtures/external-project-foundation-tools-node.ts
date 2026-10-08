import {
  createProjectFoundationToolsClient,
  CREWON_PROJECT_FOUNDATION_TOOLS_SERVICE,
  CREWON_PROJECT_FOUNDATION_TOOLS_API_VERSION,
  parseProjectFoundationToolsRequest,
  parseProjectFoundationToolsResponse,
  type PluginProjectFoundationToolsService,
  type ProjectFoundationToolsResponseMap,
} from "@crewon/plugin-sdk/project-foundation-tools";
import { definePlugin, type PluginNodeContext } from "@crewon/plugin-sdk/node";

/** A real external Node-only declaration consumer; no DOM, host source or Node typings. */
export function resolveFoundation(context: PluginNodeContext) {
  if (typeof context.services.getOptional !== "function") return undefined;
  const service =
    context.services.getOptional<PluginProjectFoundationToolsService>(
      CREWON_PROJECT_FOUNDATION_TOOLS_SERVICE,
      CREWON_PROJECT_FOUNDATION_TOOLS_API_VERSION,
    );
  return service === undefined
    ? undefined
    : createProjectFoundationToolsClient(service);
}
export function scope(
  service: PluginProjectFoundationToolsService,
  command: unknown,
): Promise<ProjectFoundationToolsResponseMap["readScope"]> {
  return service.readScope({ command, request: {} });
}
export function getFoundation(
  service: PluginProjectFoundationToolsService,
  command: unknown,
) {
  return service.getFoundation({
    command,
    request: {
      projectId: "project",
      parametersStartOffset: 0,
      parametersLimit: 1024,
    },
  });
}
export function source(
  service: PluginProjectFoundationToolsService,
  command: unknown,
  digest: string,
) {
  return service.getSource({
    command,
    request: { projectId: "project", sourceRevision: 1, sourceDigest: digest },
  });
}
export function page(
  service: PluginProjectFoundationToolsService,
  command: unknown,
  digest: string,
) {
  return service.readSourcePage({
    command,
    request: {
      projectId: "project",
      sourceRevision: 1,
      sourceDigest: digest,
      startOffset: 0,
      limit: 1024,
    },
  });
}
export function chapters(
  service: PluginProjectFoundationToolsService,
  command: unknown,
  digest: string,
) {
  return service.listSourceChapters({
    command,
    request: {
      projectId: "project",
      sourceRevision: 1,
      sourceDigest: digest,
      limit: 16,
    },
  });
}
export function proposal(
  service: PluginProjectFoundationToolsService,
  command: unknown,
  digest: string,
) {
  return service.getProposal({
    command,
    request: {
      projectId: "project",
      proposalRevision: 1,
      proposalDigest: digest,
      startOffset: 0,
      limit: 1024,
    },
  });
}
export function history(
  service: PluginProjectFoundationToolsService,
  command: unknown,
) {
  return service.listProposals({
    command,
    request: { projectId: "project", afterProposalRevision: 0, limit: 4 },
  });
}
export function save(
  service: PluginProjectFoundationToolsService,
  command: unknown,
) {
  return service.saveProposal({
    command,
    request: {
      projectId: "project",
      expectedFoundationRevision: 1,
      expectedProposalRevision: 0,
      kind: "creative-plan",
      text: "A candidate only.",
    },
  });
}
export function readResult(input: unknown) {
  const expected = parseProjectFoundationToolsRequest({
    operation: "foundation_read",
    request: { projectId: "project" },
  });
  return parseProjectFoundationToolsResponse(input, expected);
}
export function typeBoundaries(
  service: PluginProjectFoundationToolsService,
  command: unknown,
) {
  // @ts-expect-error The Node service has no confirmation method.
  service.confirmProposal({ command, request: {} });
  service.saveProposal({
    command,
    request: {
      projectId: "project",
      expectedFoundationRevision: 1,
      expectedProposalRevision: 0,
      kind: "creative-plan",
      text: "candidate",
      // @ts-expect-error Retry identity is host-derived, never supplied by a plugin.
      idempotencyKey: "caller",
    },
  });
}
export const plugin = definePlugin({
  apiVersion: "crewon.plugin-host.v1",
  pluginId: "example.foundation",
  setup(context) {
    resolveFoundation(context);
  },
});
