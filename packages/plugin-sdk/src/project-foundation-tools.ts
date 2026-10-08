import {
  PROJECT_FOUNDATION_TOOL_OPERATIONS,
  parseProjectFoundationToolsRequest,
  parseProjectFoundationToolsResponse,
  ProjectFoundationToolsContractError,
  type PluginProjectFoundationToolsService,
  type ProjectFoundationToolsInputMap,
  type ProjectFoundationToolsInvocation,
  type ProjectFoundationToolsMethod,
  type ProjectFoundationToolsResponseMap,
} from "../../contracts/src/project-foundation-tools.ts";
import { pluginUiFields } from "../../contracts/src/plugin-ui-json.ts";

export * from "../../contracts/src/project-foundation-tools.ts";

/**
 * A bounded Node data client, with no UI invocation, transport or cancellation authority.
 * Every call forwards the opaque original command unchanged; only the actual Worker can
 * qualify its live membership and Tool receipt. Creating this client grants nothing.
 */
export function createProjectFoundationToolsClient(
  service: PluginProjectFoundationToolsService,
): PluginProjectFoundationToolsService {
  let values: Readonly<Record<string, unknown>>;
  try {
    values = pluginUiFields(
      service,
      Object.keys(PROJECT_FOUNDATION_TOOL_OPERATIONS),
    );
    if (Object.values(values).some((value) => typeof value !== "function"))
      throw new ProjectFoundationToolsContractError();
  } catch {
    throw new ProjectFoundationToolsContractError();
  }
  function call<M extends ProjectFoundationToolsMethod>(method: M) {
    const callback = values[method] as (
      input: ProjectFoundationToolsInvocation<
        ProjectFoundationToolsInputMap[M]
      >,
    ) => Promise<unknown>;
    return async (
      input: ProjectFoundationToolsInvocation<
        ProjectFoundationToolsInputMap[M]
      >,
    ): Promise<ProjectFoundationToolsResponseMap[M]> => {
      let invocation: Readonly<Record<string, unknown>>;
      try {
        invocation = pluginUiFields(input, ["command", "request"]);
      } catch {
        throw new ProjectFoundationToolsContractError();
      }
      const expected = parseProjectFoundationToolsRequest({
        operation: PROJECT_FOUNDATION_TOOL_OPERATIONS[method],
        request: invocation.request,
      });
      // Capture business data before the first await, while preserving original command identity.
      const result = await Reflect.apply(callback, service, [
        Object.freeze({
          command: invocation.command,
          request: expected.request,
        }),
      ]);
      return parseProjectFoundationToolsResponse(
        result,
        expected,
      ) as ProjectFoundationToolsResponseMap[M];
    };
  }
  return Object.freeze({
    readScope: call("readScope"),
    getFoundation: call("getFoundation"),
    getSource: call("getSource"),
    readSourcePage: call("readSourcePage"),
    listSourceChapters: call("listSourceChapters"),
    getProposal: call("getProposal"),
    listProposals: call("listProposals"),
    saveProposal: call("saveProposal"),
  });
}
