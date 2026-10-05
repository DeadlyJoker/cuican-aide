import {
  PROJECT_HISTORICAL_QUERY_UI_ACTIONS,
  type PluginProjectHistoricalQueryClient,
  type ProjectHistoricalQueryUiActionRequest,
  type ProjectHistoricalQueryUiReceipt,
} from "./plugin-project-historical-queries-service.ts";
export type ProjectHistoricalQueryUiServices = Readonly<{
  invoke(
    action: string,
    input: ProjectHistoricalQueryUiActionRequest["input"],
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<unknown>;
}>;
export type ProjectHistoricalQueryUiCodec = Readonly<{
  parseRequest(input: unknown): ProjectHistoricalQueryUiActionRequest;
  parseResponse(
    request: ProjectHistoricalQueryUiActionRequest,
    output: unknown,
  ): ProjectHistoricalQueryUiReceipt;
}>;
/** A captured public UI client; only the original mounted invocation supplies authority. */
export function createPluginProjectHistoricalQueryClient(
  services: ProjectHistoricalQueryUiServices,
  codec: ProjectHistoricalQueryUiCodec,
): PluginProjectHistoricalQueryClient {
  const invoke = method(services, "invoke").bind(
    services,
  ) as ProjectHistoricalQueryUiServices["invoke"];
  const parseRequest = method(codec, "parseRequest").bind(
    codec,
  ) as ProjectHistoricalQueryUiCodec["parseRequest"];
  const parseResponse = method(codec, "parseResponse").bind(
    codec,
  ) as ProjectHistoricalQueryUiCodec["parseResponse"];
  return Object.freeze({
    async queryConceptGeneration(input, options = {}) {
      const fields = Object.getOwnPropertyDescriptors(options);
      if (
        Reflect.ownKeys(options).some((key) => key !== "signal") ||
        (fields.signal !== undefined &&
          (!fields.signal.enumerable || !("value" in fields.signal)))
      )
        invalid();
      const signal = fields.signal?.value as AbortSignal | undefined;
      if (signal !== undefined && !(signal instanceof AbortSignal)) invalid();
      signal?.throwIfAborted();
      const request = parseRequest({
        action: PROJECT_HISTORICAL_QUERY_UI_ACTIONS[0],
        input,
      });
      const output = await invoke(
        request.action,
        request.input,
        signal === undefined ? {} : { signal },
      );
      signal?.throwIfAborted();
      return parseResponse(request, output);
    },
  });
}
function method(input: object, key: string): (...args: never[]) => unknown {
  if (input === null || typeof input !== "object") invalid();
  let owner: object | null = input;
  for (
    let depth = 0;
    owner !== null && depth < 16;
    depth++, owner = Object.getPrototypeOf(owner)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor === undefined) continue;
    if (!("value" in descriptor) || typeof descriptor.value !== "function")
      invalid();
    return descriptor.value;
  }
  return invalid();
}
function invalid(): never {
  throw new Error("plugin_project_historical_query_client_invalid");
}
