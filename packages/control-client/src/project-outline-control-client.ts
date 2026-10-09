import {
  MAX_PROJECT_OUTLINE_UI_RESPONSE_BYTES,
  parseProjectOutlineUiRequest,
  parseProjectOutlineUiResponse,
  PROJECT_OUTLINE_UI_METHOD_ACTIONS as actions,
  type ProjectOutlineUiAction,
  type ProjectOutlineUiInputMap,
  type PluginProjectOutlineUiClient,
} from "@crewon/contracts/project-outlines";
import type { CreativeProjectControlTransport } from "./creative-project-control-client.ts";

/** Reuses the v2 bounded read protocol and the original authenticated HTTP transport. */
export function createProjectOutlineControlClient(
  transport: CreativeProjectControlTransport,
): PluginProjectOutlineUiClient {
  const call = async <A extends ProjectOutlineUiAction>(
    action: A,
    input: ProjectOutlineUiInputMap[A],
    options: Readonly<{ signal?: AbortSignal }> = {},
  ) => {
    let request;
    try {
      request = parseProjectOutlineUiRequest({ action, input });
    } catch {
      throw transport.protocolError(
        "control_client_project_outline_request_invalid",
      );
    }
    const { projectId, ...query } = request.input;
    const root = `/api/v2/creative-projects/${encodeURIComponent(projectId)}/outline`;
    const search = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    ).toString();
    const suffix =
      request.action === actions.getOutline
        ? ""
        : request.action === actions.getSection
          ? "/sections"
          : "/revisions";
    const controller = new AbortController();
    const caller = options.signal;
    caller?.throwIfAborted();
    const cancel = () => controller.abort(caller!.reason);
    caller?.addEventListener("abort", cancel, { once: true });
    let aborted!: () => void;
    const canceled = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", aborted, { once: true });
    });
    void canceled.catch(() => undefined);
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException("project_outline_request_timed_out", "TimeoutError"),
        ),
      30_000,
    );
    try {
      if (caller?.aborted) cancel();
      controller.signal.throwIfAborted();
      const work = Promise.resolve(
        transport.json(
          "GET",
          root + suffix + (search ? "?" + search : ""),
          null,
          {
            expectedStatuses: [200],
            maximumResponseBytes: MAX_PROJECT_OUTLINE_UI_RESPONSE_BYTES,
            redirect: "manual",
            signal: controller.signal,
          },
        ),
      );
      void work.catch(() => undefined);
      const response = await Promise.race([work, canceled]);
      controller.signal.throwIfAborted();
      try {
        return parseProjectOutlineUiResponse({ action, input }, response);
      } catch {
        throw transport.protocolError(
          "control_client_project_outline_response_invalid",
        );
      }
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", aborted);
    }
  };
  return Object.freeze({
    getOutline: (input, options) => call(actions.getOutline, input, options),
    getSection: (input, options) => call(actions.getSection, input, options),
    listRevisions: (input, options) =>
      call(actions.listRevisions, input, options),
  });
}
