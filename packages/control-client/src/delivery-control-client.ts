import {
  DELIVERY_LIMITS,
  deliveryId,
  type DeliveryAssembleRequest,
  type DeliveryInputRecord,
  type DeliveryPatchRequest,
} from "@crewon/domain/delivery";
import {
  parseDeliveryCatalog,
  parseDeliveryHistory,
  parseDeliveryInput,
  parseDeliveryVersion,
  parseSpreadsheetPage,
} from "./delivery-response.ts";

export type DeliveryRequestOptions = Readonly<{ signal?: AbortSignal }>;
type JsonOptions = DeliveryRequestOptions & {
  idempotencyKey?: string;
  requireCsrf?: boolean;
  requireIdempotency?: boolean;
  expectedStatuses: readonly number[];
  maximumResponseBytes: number;
  responseShape?: "object" | "array";
};
export type DeliveryControlTransport = {
  json(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    options: JsonOptions,
  ): Promise<unknown>;
  binary(path: string, options: DeliveryRequestOptions): Promise<Response>;
};
export type DeliveryFileRef = Readonly<{
  kind: "input" | "version";
  id: string;
}>;
export type DeliveryUploadRequest = Readonly<
  Pick<DeliveryInputRecord, "name" | "role" | "mediaType"> & {
    contentBase64: string;
  }
>;
const MAX_METADATA_BYTES = 1024 * 1024;

/** Uses the owning ControlApiClient transport, including its session and CSRF policy. */
export class DeliveryControlClient {
  readonly #transport: DeliveryControlTransport;
  constructor(transport: DeliveryControlTransport) {
    this.#transport = transport;
  }
  async catalog(threadId: string, options: DeliveryRequestOptions = {}) {
    return parseDeliveryCatalog(
      await this.#transport.json(
        "GET",
        path(threadId),
        null,
        readOptions(options),
      ),
      threadId,
    );
  }
  async upload(
    threadId: string,
    body: DeliveryUploadRequest,
    idempotencyKey: string,
    options: DeliveryRequestOptions = {},
  ) {
    if (
      body.contentBase64.length >
      Math.ceil(DELIVERY_LIMITS.fileBytes / 3) * 4
    )
      throw new TypeError("delivery_file_too_large");
    return parseDeliveryInput(
      await this.#transport.json(
        "POST",
        `${path(threadId)}/inputs`,
        body,
        writeOptions(options, idempotencyKey),
      ),
      threadId,
    );
  }
  async assemble(
    threadId: string,
    body: DeliveryAssembleRequest,
    idempotencyKey: string,
    options: DeliveryRequestOptions = {},
  ) {
    return parseDeliveryVersion(
      await this.#transport.json(
        "POST",
        `${path(threadId)}/assemble`,
        body,
        writeOptions(options, idempotencyKey),
      ),
      threadId,
    );
  }
  async patch(
    threadId: string,
    body: DeliveryPatchRequest,
    idempotencyKey: string,
    options: DeliveryRequestOptions = {},
  ) {
    const version = parseDeliveryVersion(
      await this.#transport.json(
        "POST",
        `${path(threadId)}/patch`,
        body,
        writeOptions(options, idempotencyKey),
      ),
      threadId,
    );
    if (
      version.deliveryId !== body.deliveryId ||
      version.parentVersionId !== body.expectedVersionId
    )
      throw new TypeError("control_client_delivery_patch_response_invalid");
    return version;
  }
  async version(
    threadId: string,
    versionId: string,
    options: DeliveryRequestOptions = {},
  ) {
    const version = parseDeliveryVersion(
      await this.#transport.json(
        "GET",
        `${path(threadId)}/versions/${id(versionId)}`,
        null,
        readOptions(options),
      ),
      threadId,
    );
    if (version.versionId !== versionId)
      throw new TypeError("control_client_delivery_version_mismatch");
    return version;
  }
  async history(
    threadId: string,
    deliveryId: string,
    options: DeliveryRequestOptions = {},
  ) {
    return parseDeliveryHistory(
      await this.#transport.json(
        "GET",
        `${path(threadId)}/history/${id(deliveryId)}`,
        null,
        { ...readOptions(options), responseShape: "array" },
      ),
      threadId,
      deliveryId,
    );
  }
  async page(
    threadId: string,
    ref: DeliveryFileRef,
    query: { sheet: string; startRow: number; limit: number },
    options: DeliveryRequestOptions = {},
  ) {
    if (
      !Number.isSafeInteger(query.startRow) ||
      query.startRow < 1 ||
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > DELIVERY_LIMITS.pageRows ||
      !query.sheet ||
      query.sheet.length > 128
    )
      throw new TypeError("delivery_page_query_invalid");
    const search = new URLSearchParams({
      sheet: query.sheet,
      startRow: String(query.startRow),
      limit: String(query.limit),
    });
    return parseSpreadsheetPage(
      await this.#transport.json(
        "GET",
        `${filePath(threadId, ref)}/page?${search}`,
        null,
        {
          ...readOptions(options),
          maximumResponseBytes: DELIVERY_LIMITS.pageBytes,
        },
      ),
      query,
    );
  }
  async download(
    threadId: string,
    ref: DeliveryFileRef,
    expected: Pick<
      DeliveryInputRecord,
      "mediaType" | "byteLength" | "contentDigest"
    >,
    options: DeliveryRequestOptions = {},
  ): Promise<Uint8Array> {
    const response = await this.#transport.binary(
      `${filePath(threadId, ref)}/content`,
      options,
    );
    if (
      response.headers.get("content-type")?.split(";")[0] !==
        expected.mediaType ||
      expected.byteLength > DELIVERY_LIMITS.fileBytes ||
      expected.byteLength < 1 ||
      !response.body
    )
      throw new TypeError("control_client_delivery_download_invalid");
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      Number(declaredLength) !== expected.byteLength
    )
      throw new TypeError("control_client_delivery_length_mismatch");
    const reader = response.body.getReader();
    const content = new Uint8Array(expected.byteLength);
    let offset = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (offset + chunk.value.length > content.length)
          throw new TypeError("control_client_delivery_download_too_large");
        content.set(chunk.value, offset);
        offset += chunk.value.length;
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    if (offset !== content.length)
      throw new TypeError("control_client_delivery_length_mismatch");
    const digest = await globalThis.crypto.subtle.digest("SHA-256", content);
    const hex = [...new Uint8Array(digest)]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    if (`sha256:${hex}` !== expected.contentDigest)
      throw new TypeError("control_client_delivery_digest_mismatch");
    return content;
  }
}
function readOptions(options: DeliveryRequestOptions): JsonOptions {
  return {
    ...options,
    expectedStatuses: [200],
    maximumResponseBytes: MAX_METADATA_BYTES,
  };
}
function writeOptions(
  options: DeliveryRequestOptions,
  idempotencyKey: string,
): JsonOptions {
  return {
    ...readOptions(options),
    idempotencyKey,
    requireCsrf: true,
    requireIdempotency: true,
    expectedStatuses: [200, 201],
  };
}
function id(value: string): string {
  return encodeURIComponent(deliveryId(value));
}
function path(threadId: string): string {
  return `/api/v1/threads/${id(threadId)}/delivery`;
}
function filePath(threadId: string, ref: DeliveryFileRef): string {
  return `${path(threadId)}/${ref.kind === "input" ? "inputs" : "versions"}/${id(ref.id)}`;
}
