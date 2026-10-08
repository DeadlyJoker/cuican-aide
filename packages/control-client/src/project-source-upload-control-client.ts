import {
  MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES,
  PROJECT_SOURCE_UPLOAD_PART_BYTES,
  parseProjectSourceUploadPartLocator,
  parseProjectSourceUploadPartPath,
  parseProjectSourceUploadPartResponse,
  projectSourceUploadPartPath,
  type ProjectSourceUploadPartLocator,
  type ProjectSourceUploadMutationResponse,
} from "@crewon/contracts/project-source-uploads";
import { parsePluginControlMountRef } from "@crewon/contracts";

export type PluginSourceUploadPartTransport = Readonly<{
  rawPart?(
    path: string,
    bytes: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
  ): Promise<unknown>;
  protocolError(code: string): Error;
}>;

/** A single original part write. Retry and whole-file orchestration belong to the plugin. */
export async function writePluginSourceUploadPart(
  transport: PluginSourceUploadPartTransport,
  mountRef: string,
  locatorInput: ProjectSourceUploadPartLocator,
  input: Uint8Array,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<ProjectSourceUploadMutationResponse> {
  let locator: ProjectSourceUploadPartLocator;
  let path: string;
  let bytes: Uint8Array<ArrayBuffer>;
  let signal: AbortSignal;
  try {
    locator = parseProjectSourceUploadPartLocator(locatorInput);
    path = projectSourceUploadPartPath(
      parsePluginControlMountRef(mountRef),
      locator,
    );
    bytes = captureBytes(input);
    if (
      options === null ||
      typeof options !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
      Reflect.ownKeys(options).some((key) => key !== "signal")
    )
      throw new Error();
    const descriptor = Object.getOwnPropertyDescriptor(options, "signal");
    if (
      descriptor !== undefined &&
      (!descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        (descriptor.value !== undefined &&
          !(descriptor.value instanceof AbortSignal)))
    )
      throw new Error();
    signal = descriptor?.value ?? new AbortController().signal;
  } catch {
    throw transport.protocolError("control_client_plugin_request_invalid");
  }
  signal.throwIfAborted();
  if (transport.rawPart === undefined)
    throw transport.protocolError(
      "control_client_plugin_source_upload_unavailable",
    );
  const result = await transport.rawPart(path, bytes, signal);
  signal.throwIfAborted();
  try {
    return parseProjectSourceUploadPartResponse(
      result,
      locator,
      bytes.byteLength,
    );
  } catch {
    throw transport.protocolError("control_client_plugin_response_invalid");
  }
}

function captureBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const prototype = Object.getPrototypeOf(Uint8Array.prototype);
  const tag = Object.getOwnPropertyDescriptor(
    prototype,
    Symbol.toStringTag,
  )!.get!;
  const length = Object.getOwnPropertyDescriptor(prototype, "byteLength")!.get!;
  const buffer = Object.getOwnPropertyDescriptor(prototype, "buffer")!.get!;
  if (tag.call(input) !== "Uint8Array") throw new Error();
  const count = length.call(input);
  const backing = buffer.call(input);
  Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    "byteLength",
  )!.get!.call(backing);
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > PROJECT_SOURCE_UPLOAD_PART_BYTES
  )
    throw new Error();
  const bytes = new Uint8Array(count);
  Uint8Array.prototype.set.call(bytes, input);
  return bytes;
}

/** Only ControlApiClient supplies these authenticated headers; the plugin receives no credential port. */
export async function requestPluginSourceUploadPart(
  transport: Readonly<{
    fetch: typeof globalThis.fetch;
    baseUrl: string | URL;
    headers: Headers;
    csrfToken: string | null;
    protocolError(code: string): Error;
    readError(response: Response, maximumBytes: number): Promise<Error>;
    readJson(response: Response, maximumBytes: number): Promise<unknown>;
  }>,
  path: string,
  bytes: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
): Promise<unknown> {
  parseProjectSourceUploadPartPath(path);
  signal.throwIfAborted();
  if (transport.csrfToken === null)
    throw transport.protocolError("control_client_csrf_token_required");
  const headers = new Headers(transport.headers);
  headers.set("x-csrf-token", transport.csrfToken);
  headers.set("content-type", "application/octet-stream");
  const response = await transport.fetch(new URL(path, transport.baseUrl), {
    method: "PUT",
    headers,
    body: bytes,
    credentials: "include",
    redirect: "manual",
    signal,
  });
  if (response.status !== 200)
    throw await transport.readError(
      response,
      MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES,
    );
  return transport.readJson(response, MAX_PROJECT_SOURCE_UPLOAD_RESPONSE_BYTES);
}
