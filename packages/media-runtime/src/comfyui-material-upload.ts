import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  parseFrozenProjectReferenceMaterial,
  type FrozenProjectReferenceMaterialContent,
} from "@crewon/application";
import {
  projectAssetInputFields,
  extensionCanonicalJson,
} from "@crewon/domain";
import {
  inspectProjectMaterialPng,
  MAX_PROJECT_MATERIAL_BYTES,
} from "./project-material-png.ts";
import type { PinnedHttpResponse } from "./pinned-node-http.ts";
import {
  materialByteLength,
  copyBoundedMaterialBytes,
} from "./material-byte-snapshot.ts";
const sha = (bytes: Uint8Array | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export const MAX_COMFY_MATERIAL_UPLOAD_BYTES =
  MAX_PROJECT_MATERIAL_BYTES + 64 * 1024;
export const MAX_COMFY_MATERIAL_UPLOAD_RESPONSE_BYTES = 64 * 1024;
export type ComfyMaterialUploadPlan = Readonly<{
  preparationId: string;
  origin: string;
  source: Readonly<{
    archiveId: string;
    materialId: string;
    recordDigest: string;
    byteDigest: string;
    byteLength: number;
    width: number;
    height: number;
  }>;
  output: Readonly<{
    filename: string;
    subfolder: string;
    type: "output" | "input";
  }>;
  viewPath: string;
  requestDigest: string;
  request: Readonly<{
    method: "POST";
    path: "/upload/image" | "/api/comfy/upload/file";
    headers: Readonly<Record<string, string>>;
    body: Uint8Array;
    maxRequestBytes: number;
    maxResponseBytes: number;
  }>;
}>;
/** Pure host decoder. Bytes and DTOs do not grant project, target-network or single-dispatch authority.
 * A durable preparation reservation must pin this request and claim dispatch before transport.
 */
export function renderComfyMaterialUpload(
  input: Readonly<{
    preparationId: string;
    targetServiceOrigin: string;
    content: FrozenProjectReferenceMaterialContent;
    adapter?: "comfyui-image-upload.v1" | "comfyui-workflow-file-upload.v1";
  }>,
): ComfyMaterialUploadPlan {
  if (!input || typeof input !== "object" || types.isProxy(input))
    fail("input_invalid");
  const q = fields(input, [
    "preparationId",
    "targetServiceOrigin",
    "content",
    ...(Object.hasOwn(input, "adapter") ? ["adapter"] : []),
  ]);
  if (
    q.adapter !== undefined &&
    q.adapter !== "comfyui-image-upload.v1" &&
    q.adapter !== "comfyui-workflow-file-upload.v1"
  )
    fail("adapter_invalid");
  const workflowApi = q.adapter === "comfyui-workflow-file-upload.v1";
  if (
    typeof q.preparationId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      q.preparationId,
    ) ||
    typeof q.targetServiceOrigin !== "string" ||
    q.targetServiceOrigin.length > 2048
  )
    fail("input_invalid");
  let base: URL;
  try {
    base = new URL(q.targetServiceOrigin);
  } catch {
    fail("origin_invalid");
  }
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    base.href !== q.targetServiceOrigin
  )
    fail("origin_invalid");
  const raw = fields(q.content, ["record", "bytes"]),
    record = parseFrozenProjectReferenceMaterial(raw.record, { sha256: sha });
  if (
    types.isProxy(raw.bytes) ||
    !(raw.bytes instanceof Uint8Array) ||
    materialByteLength(raw.bytes) !== record.source.byteLength ||
    materialByteLength(raw.bytes) > MAX_PROJECT_MATERIAL_BYTES
  )
    fail("bytes_invalid");
  const bytes = copyBoundedMaterialBytes(raw.bytes, {
      maxBytes: MAX_PROJECT_MATERIAL_BYTES,
      expectedBytes: record.source.byteLength,
    }),
    dimensions = inspectProjectMaterialPng(bytes);
  if (
    bytes.length !== record.source.byteLength ||
    sha(bytes) !== record.source.byteDigest ||
    dimensions.width !== record.source.width ||
    dimensions.height !== record.source.height
  )
    fail("bytes_invalid");
  const preparationId = q.preparationId,
    output = Object.freeze({
      filename: workflowApi
        ? `material-${preparationId}-${record.source.byteDigest.slice(7)}.png`
        : `material-${record.source.byteDigest.slice(7)}.png`,
      subfolder: workflowApi ? "" : `crewon-materials/${preparationId}`,
      type: workflowApi ? ("input" as const) : ("output" as const),
    }),
    boundary = `crewon-${preparationId}`;
  if (bytes.includes(Buffer.from(`\r\n--${boundary}`)))
    fail("multipart_collision");
  const form = (name: string, value: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const body = Buffer.concat([
    Buffer.from(
      (workflowApi
        ? ""
        : form("type", "output") + form("subfolder", output.subfolder)) +
        form("overwrite", "false") +
        `--${boundary}\r\nContent-Disposition: form-data; name="${workflowApi ? "file" : "image"}"; filename="${output.filename}"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  if (body.length > MAX_COMFY_MATERIAL_UPLOAD_BYTES) fail("body_limit");
  const source = Object.freeze({
    archiveId: record.archiveId,
    materialId: record.materialId,
    recordDigest: sha(extensionCanonicalJson(record)),
    byteDigest: record.source.byteDigest,
    byteLength: bytes.length,
    ...dimensions,
  });
  const headers = Object.freeze({
    "content-type": `multipart/form-data; boundary=${boundary}`,
    "accept": "application/json",
    "accept-encoding": "identity",
  });
  const request = Object.freeze({
    method: "POST" as const,
    path: workflowApi
      ? ("/api/comfy/upload/file" as const)
      : ("/upload/image" as const),
    headers,
    body,
    maxRequestBytes: MAX_COMFY_MATERIAL_UPLOAD_BYTES,
    maxResponseBytes: MAX_COMFY_MATERIAL_UPLOAD_RESPONSE_BYTES,
  });
  const viewPath = `${workflowApi ? "/api/comfy/view" : "/view"}?${new URLSearchParams(output)}`,
    requestDigest = sha(
      extensionCanonicalJson({
        preparationId,
        origin: base.href,
        source,
        output,
        method: request.method,
        path: request.path,
        headers,
        bodyDigest: sha(body),
        maxRequestBytes: request.maxRequestBytes,
        maxResponseBytes: request.maxResponseBytes,
      }),
    );
  return Object.freeze({
    preparationId,
    origin: base.href,
    source,
    output,
    viewPath,
    requestDigest,
    request,
  });
}
/** An exact acknowledgement is not a target-byte proof. Never follow returned URLs or asset identifiers. */
export function verifyComfyMaterialUploadAcknowledgement(
  plan: ComfyMaterialUploadPlan,
  response: PinnedHttpResponse,
): void {
  if (
    response.status !== 200 ||
    response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
      "application/json" ||
    (response.headers["content-encoding"] !== undefined &&
      response.headers["content-encoding"] !== "identity") ||
    !(response.body instanceof Uint8Array) ||
    materialByteLength(response.body) > MAX_COMFY_MATERIAL_UPLOAD_RESPONSE_BYTES
  )
    fail("acknowledgement_invalid");
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        copyBoundedMaterialBytes(response.body, {
          maxBytes: MAX_COMFY_MATERIAL_UPLOAD_RESPONSE_BYTES,
          expectedBytes: null,
        }),
      ),
    );
  } catch {
    fail("acknowledgement_invalid");
  }
  if (
    !decoded ||
    typeof decoded !== "object" ||
    Array.isArray(decoded) ||
    Object.keys(decoded).some(
      (key) => !["name", "subfolder", "type", "asset"].includes(key),
    )
  )
    fail("acknowledgement_invalid");
  const value = decoded as Record<string, unknown>;
  if (
    value.name !== plan.output.filename ||
    value.subfolder !== plan.output.subfolder ||
    value.type !== plan.output.type
  )
    fail("acknowledgement_identity_changed");
}
export function verifyComfyMaterialTargetBytes(
  plan: ComfyMaterialUploadPlan,
  response: PinnedHttpResponse,
): Readonly<{
  byteDigest: string;
  byteLength: number;
  width: number;
  height: number;
}> {
  if (
    response.status !== 200 ||
    response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
      "image/png" ||
    (response.headers["content-encoding"] !== undefined &&
      response.headers["content-encoding"] !== "identity") ||
    !(response.body instanceof Uint8Array) ||
    materialByteLength(response.body) !== plan.source.byteLength
  )
    fail("target_invalid");
  const bytes = copyBoundedMaterialBytes(response.body, {
      maxBytes: MAX_PROJECT_MATERIAL_BYTES,
      expectedBytes: plan.source.byteLength,
    }),
    dimensions = inspectProjectMaterialPng(bytes),
    byteDigest = sha(bytes),
    length = response.headers["content-length"];
  if (
    byteDigest !== plan.source.byteDigest ||
    dimensions.width !== plan.source.width ||
    dimensions.height !== plan.source.height ||
    (length !== undefined &&
      (!/^(0|[1-9][0-9]*)$/u.test(length) || Number(length) !== bytes.length))
  )
    fail("target_mismatch");
  return Object.freeze({ byteDigest, byteLength: bytes.length, ...dimensions });
}
function fields(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (input !== null && typeof input === "object" && types.isProxy(input))
    fail("input_invalid");
  return projectAssetInputFields(input, keys);
}
function fail(code: string): never {
  throw new Error(`comfyui_material_upload_${code}`);
}
