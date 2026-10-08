import {
  MAX_PROJECT_SOURCE_UPLOAD_INPUT_BYTES,
  PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS,
  projectSourceUploadsCodec,
  parseProjectSourceUploadPartLocator,
  parseProjectSourceUploadPartResponse,
  type ProjectSourceUploadInputMap,
  type ProjectSourceUploadMethod,
  type ProjectSourceUploadResponseMap,
} from "../../contracts/src/project-source-uploads.ts";
import { parsePluginUiJsonValue } from "../../contracts/src/plugin-ui-json.ts";
import { fail } from "./definition-validation.js";
import { captureSourceUploadPartBytes } from "./project-source-upload-client-bytes.js";
import {
  captureSourceUploadClientMethod,
  invokeSourceUploadClient,
  sourceUploadClientRecord,
  sourceUploadSignal,
} from "./project-source-upload-client-invocation.js";
import type {
  PluginProjectSourceUploadClientOptions,
  PluginProjectSourceUploadInvocationOptions,
  PluginProjectSourceUploadRawPort,
  PluginProjectSourceUploadsClient,
  PluginProjectSourceUploadUiServices,
} from "./project-source-uploads.types.js";

export * from "../../contracts/src/project-source-uploads.ts";
export type {
  PluginProjectSourceUploadClientOptions,
  PluginProjectSourceUploadInvocationOptions,
  PluginProjectSourceUploadRawPort,
  PluginProjectSourceUploadSignal,
  PluginProjectSourceUploadsClient,
  PluginProjectSourceUploadUiServices,
} from "./project-source-uploads.types.js";

/** Captures original JSON invocation and an optional, separate native byte port. It performs no probe or upload. */
export function createPluginProjectSourceUploadsClient(
  services: PluginProjectSourceUploadUiServices,
  options: PluginProjectSourceUploadClientOptions = {},
): PluginProjectSourceUploadsClient {
  const invokeHost = captureSourceUploadClientMethod<
    PluginProjectSourceUploadUiServices["invoke"]
  >(services, "invoke");
  const configuration = sourceUploadClientRecord(options, ["raw"]);
  const writeHost =
    configuration.raw === undefined
      ? undefined
      : captureSourceUploadClientMethod<
          PluginProjectSourceUploadRawPort["writePart"]
        >(configuration.raw, "writePart");
  async function invoke<Method extends ProjectSourceUploadMethod>(
    method: Method,
    input: ProjectSourceUploadInputMap[Method],
    invocationOptions: PluginProjectSourceUploadInvocationOptions = {},
  ): Promise<ProjectSourceUploadResponseMap[Method]> {
    const signal = sourceUploadSignal(invocationOptions);
    const request = projectSourceUploadsCodec.parseRequest({
      action: PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS[method],
      input,
    });
    const json = parsePluginUiJsonValue(request.input, {
      maxBytes: MAX_PROJECT_SOURCE_UPLOAD_INPUT_BYTES,
    });
    return invokeSourceUploadClient(
      signal,
      () => invokeHost(request.action, json, signal ? { signal } : {}),
      (output) =>
        projectSourceUploadsCodec.parseResponse(
          output,
          request,
        ) as ProjectSourceUploadResponseMap[Method],
    );
  }
  const client: PluginProjectSourceUploadsClient = {
    begin: (input, invocationOptions) =>
      invoke("begin", input, invocationOptions),
    status: (input, invocationOptions) =>
      invoke("status", input, invocationOptions),
    prepare: (input, invocationOptions) =>
      invoke("prepare", input, invocationOptions),
    cancel: (input, invocationOptions) =>
      invoke("cancel", input, invocationOptions),
    async writePart(input, bytes, invocationOptions = {}) {
      const signal = sourceUploadSignal(invocationOptions);
      if (writeHost === undefined)
        fail("plugin_project_source_upload_raw_port_required");
      const locator = parseProjectSourceUploadPartLocator(input);
      const snapshot = captureSourceUploadPartBytes(bytes);
      const byteLength = snapshot.byteLength;
      return invokeSourceUploadClient(
        signal,
        () => writeHost(locator, snapshot, signal ? { signal } : {}),
        (output) =>
          parseProjectSourceUploadPartResponse(output, locator, byteLength),
      );
    },
  };
  return Object.freeze(client);
}
