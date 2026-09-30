export interface ComfyJsonHttpPort {
  request(
    input: Readonly<{
      method: "GET" | "POST";
      path: string;
      body?: unknown;
      signal: AbortSignal;
    }>,
  ): Promise<unknown>;
}

export type ComfyImageReference = Readonly<{
  filename: string;
  subfolder: string;
  type: "output";
}>;
export type ComfyJobObservation =
  | Readonly<{
      status: "queued" | "running" | "unknownOutcome" | "failed";
      images: readonly [];
    }>
  | Readonly<{ status: "succeeded"; images: readonly ComfyImageReference[] }>;

export class ComfyApiError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ComfyApiError";
    this.code = code;
  }
}

/** Protocol adapter only. Transport, authorization and durable receipts belong to the host. */
export class ComfyApi {
  readonly #http: ComfyJsonHttpPort;
  constructor(http: ComfyJsonHttpPort) {
    this.#http = http;
  }

  async submit(input: {
    workflow: unknown;
    requestId: string;
    signal: AbortSignal;
  }): Promise<{ promptId: string }> {
    const requestId = promptId(input.requestId);
    // This is a correlation ID, not a claim that ComfyUI deduplicates POST /prompt.
    const response = object(
      await this.#http.request({
        method: "POST",
        path: "/prompt",
        signal: input.signal,
        body: {
          prompt: input.workflow,
          prompt_id: requestId,
          client_id: requestId,
          extra_data: { crewon_request_id: requestId },
        },
      }),
    );
    if (
      response.error !== undefined ||
      (response.node_errors !== undefined &&
        Object.keys(object(response.node_errors)).length > 0)
    )
      throw new ComfyApiError("comfy_prompt_rejected");
    return { promptId: promptId(response.prompt_id) };
  }

  async observe(input: {
    promptId: string;
    outputNodeId: string;
    signal: AbortSignal;
  }): Promise<ComfyJobObservation> {
    const id = promptId(input.promptId);
    if (!/^[0-9]{1,8}$/u.test(input.outputNodeId))
      throw new ComfyApiError("comfy_output_node_invalid");
    const history = object(
      await this.#http.request({
        method: "GET",
        path: `/history/${id}`,
        signal: input.signal,
      }),
    );
    if (Object.hasOwn(history, id)) {
      const record = object(history[id]);
      const status = object(record.status);
      if (status.status_str === "error")
        return { status: "failed", images: [] };
      if (status.completed === true && status.status_str === "success") {
        const output = object(object(record.outputs)[input.outputNodeId]);
        if (
          !Array.isArray(output.images) ||
          output.images.length < 1 ||
          output.images.length > 16
        )
          throw new ComfyApiError("comfy_images_invalid");
        return {
          status: "succeeded",
          images: output.images.map(imageReference),
        };
      }
    }
    const queue = object(
      await this.#http.request({
        method: "GET",
        path: "/queue",
        signal: input.signal,
      }),
    );
    for (const [key, state] of [
      ["queue_running", "running"],
      ["queue_pending", "queued"],
    ] as const) {
      const items = queue[key];
      if (!Array.isArray(items) || items.length > 10_000)
        throw new ComfyApiError("comfy_queue_invalid");
      if (items.some((item) => Array.isArray(item) && item[1] === id))
        return { status: state, images: [] };
    }
    // History is process-local/retained by ComfyUI. Absence does not prove never submitted.
    return { status: "unknownOutcome", images: [] };
  }
}

export function comfyImagePath(input: ComfyImageReference): string {
  const image = imageReference(input);
  return `/view?${new URLSearchParams(image)}`;
}

function imageReference(input: unknown): ComfyImageReference {
  const value = object(input);
  if (
    typeof value.filename !== "string" ||
    !value.filename ||
    value.filename.length > 255 ||
    /[\\/\u0000-\u001f\u007f]/u.test(value.filename) ||
    value.filename === "." ||
    value.filename === ".." ||
    typeof value.subfolder !== "string" ||
    value.subfolder.length > 512 ||
    /[\\\u0000-\u001f\u007f]/u.test(value.subfolder) ||
    value.subfolder.startsWith("/") ||
    value.subfolder.split("/").some((part) => part === "." || part === "..") ||
    value.type !== "output"
  )
    throw new ComfyApiError("comfy_image_reference_invalid");
  return Object.freeze({
    filename: value.filename,
    subfolder: value.subfolder,
    type: "output",
  });
}

function promptId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      value,
    )
  )
    throw new ComfyApiError("comfy_prompt_id_invalid");
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ComfyApiError("comfy_response_invalid");
  return value as Record<string, unknown>;
}
