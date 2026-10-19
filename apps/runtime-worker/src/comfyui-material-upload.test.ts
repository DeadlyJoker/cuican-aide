import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { extensionCanonicalJson } from "@crewon/domain";
import { materialArchiveInput } from "../../../packages/artifacts/src/project-material-archive.test-support.ts";
import { materialPng, pngChunk } from "./project-material-png.test-support.ts";
import {
  renderComfyMaterialUpload,
  verifyComfyMaterialUploadAcknowledgement,
  verifyComfyMaterialTargetBytes,
} from "./comfyui-material-upload.ts";

const preparationId = "2498568b-b7bd-4f47-969a-ef8c1ee42c2b";
const origin = "https://provider.example:8443/";
const sha = (b: Uint8Array) =>
  `sha256:${createHash("sha256").update(b).digest("hex")}`;
// Named mechanical DTOs only; these tests do not issue project or dispatch authority.
const fixture = (bytes = materialPng()) => ({
  preparationId,
  targetServiceOrigin: origin,
  content: materialArchiveInput(bytes),
});
const acknowledgement = (
  plan: ReturnType<typeof renderComfyMaterialUpload>,
  overrides: Record<string, unknown> = {},
) => ({
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: Buffer.from(
    JSON.stringify({
      name: plan.output.filename,
      subfolder: plan.output.subfolder,
      type: plan.output.type,
      ...overrides,
    }),
  ),
});

test("multipart carries exact frozen bytes in a separate output namespace without overwrite", async () => {
  const q = fixture(),
    p = renderComfyMaterialUpload(q);
  const form = await new Request(new URL(p.request.path, p.origin), {
    method: p.request.method,
    headers: p.request.headers,
    body: Buffer.from(p.request.body),
  }).formData();
  const names: string[] = [];
  form.forEach((_value, name) => names.push(name));
  assert.deepEqual(names, ["type", "subfolder", "overwrite", "image"]);
  assert.equal(form.get("type"), "output");
  assert.equal(form.get("subfolder"), `crewon-materials/${preparationId}`);
  assert.equal(form.get("overwrite"), "false");
  const image = form.get("image") as File;
  assert.equal(
    image.name,
    `material-${q.content.record.source.byteDigest.slice(7)}.png`,
  );
  assert.equal(image.type, "image/png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), q.content.bytes);
  const url = new URL(p.viewPath, p.origin);
  assert.deepEqual(Object.fromEntries(url.searchParams), { ...p.output });
  assert.equal(url.pathname, "/view");
  assert.equal(
    p.source.recordDigest,
    sha(Buffer.from(extensionCanonicalJson(q.content.record))),
  );
});

test("same frozen request is deterministic; new preparation never reuses the target path", () => {
  const q = fixture(),
    p = renderComfyMaterialUpload(q),
    repeated = renderComfyMaterialUpload(q);
  assert.deepEqual(p, repeated);
  const other = renderComfyMaterialUpload({
    ...q,
    preparationId: "3498568b-b7bd-4f47-969a-ef8c1ee42c2b",
  });
  assert.notEqual(other.requestDigest, p.requestDigest);
  assert.notEqual(other.viewPath, p.viewPath);
  assert.equal(other.source.byteDigest, p.source.byteDigest);
  assert.equal(other.output.filename, p.output.filename);
});

test("source bytes are captured before caller mutation; corrupted or false-sized bytes fail", () => {
  const q = fixture(),
    original = Buffer.from(q.content.bytes),
    p = renderComfyMaterialUpload(q);
  q.content.bytes.fill(0);
  assert.equal(Buffer.from(p.request.body).includes(original), true);
  assert.throws(() => renderComfyMaterialUpload(q));
  assert.throws(() =>
    renderComfyMaterialUpload({
      ...fixture(),
      content: { ...fixture().content, bytes: Buffer.alloc(4) },
    }),
  );
  const forged = fixture();
  Object.defineProperty(forged.content.bytes, "byteLength", { value: 999 });
  Object.defineProperty(forged.content.bytes, "length", {
    value: 16 * 1024 * 1024,
  });
  Object.defineProperty(forged.content.bytes, "byteOffset", {
    get() {
      throw new Error("must_not_read_offset");
    },
  });
  Object.defineProperty(forged.content.bytes, "buffer", {
    get() {
      throw new Error("must_not_read_buffer");
    },
  });
  // An own accessor cannot falsify the native length; the valid underlying bytes still match.
  assert.equal(
    renderComfyMaterialUpload(forged).source.byteLength,
    original.length,
  );
  const tooLarge = Buffer.alloc(16 * 1024 * 1024 + 1);
  Object.defineProperty(tooLarge, "byteLength", { value: original.length });
  assert.throws(
    () =>
      renderComfyMaterialUpload({
        ...fixture(),
        content: { ...fixture().content, bytes: tooLarge },
      }),
    /bytes_invalid/u,
  );
});

for (const targetServiceOrigin of [
  "http://provider.example/",
  "https://u:p@provider.example/",
  "https://provider.example/base/",
  "https://provider.example/?x=1",
  "https://provider.example/#x",
  "https://PROVIDER.example/",
  "https://provider.example",
]) {
  test(`noncanonical target rejected: ${targetServiceOrigin}`, () =>
    assert.throws(() =>
      renderComfyMaterialUpload({ ...fixture(), targetServiceOrigin }),
    ));
}
for (const id of [
  "x",
  "2498568b-b7bd-1f47-969a-ef8c1ee42c2b",
  "2498568b-b7bd-4f47-169a-ef8c1ee42c2b",
  "2498568B-b7bd-4f47-969a-ef8c1ee42c2b",
]) {
  test(`invalid preparation identity rejected: ${id}`, () =>
    assert.throws(() =>
      renderComfyMaterialUpload({ ...fixture(), preparationId: id }),
    ));
}

test("caller getters, unknown fields, proxies and multipart delimiter collisions fail", () => {
  let accessed = false;
  const q = fixture();
  assert.throws(() =>
    renderComfyMaterialUpload({
      ...q,
      get extra() {
        accessed = true;
        return true;
      },
    } as typeof q),
  );
  assert.equal(accessed, false);
  assert.throws(() => renderComfyMaterialUpload(new Proxy(q, {})));
  assert.throws(() =>
    renderComfyMaterialUpload({
      ...q,
      content: { ...q.content, bytes: new Proxy(q.content.bytes, {}) },
    }),
  );
  const bytes = materialPng(),
    chunk = pngChunk(
      "tEXt",
      Buffer.from(`note\0\r\n--crewon-${preparationId}\r\n`),
    );
  const colliding = Buffer.concat([
    bytes.subarray(0, 33),
    chunk,
    bytes.subarray(33),
  ]);
  assert.throws(
    () => renderComfyMaterialUpload(fixture(colliding)),
    /multipart_collision/u,
  );
});

test("exact supplier acknowledgement is accepted without interpreting optional asset metadata", () => {
  const p = renderComfyMaterialUpload(fixture());
  verifyComfyMaterialUploadAcknowledgement(p, acknowledgement(p));
  verifyComfyMaterialUploadAcknowledgement(
    p,
    acknowledgement(p, {
      asset: { asset_hash: "untrusted", url: "http://localhost/" },
    }),
  );
});
for (const change of [
  { name: "renamed.png" },
  { subfolder: "../other" },
  { type: "input" },
  { url: "https://evil.example/" },
  { type: undefined },
]) {
  test(`changed acknowledgement refused: ${JSON.stringify(change)}`, () => {
    const p = renderComfyMaterialUpload(fixture());
    assert.throws(() =>
      verifyComfyMaterialUploadAcknowledgement(p, acknowledgement(p, change)),
    );
  });
}

test("invalid status, MIME, encoding, oversized or malformed acknowledgement is refused", () => {
  const p = renderComfyMaterialUpload(fixture()),
    r = acknowledgement(p);
  for (const wrong of [
    { ...r, status: 302 },
    { ...r, headers: { "content-type": "text/html" } },
    { ...r, headers: { ...r.headers, "content-encoding": "gzip" } },
    { ...r, body: Buffer.alloc(64 * 1024 + 1) },
    { ...r, body: Buffer.from([255]) },
    { ...r, body: Buffer.from("{}{}") },
    { ...r, body: Buffer.from("[]") },
    { ...r, body: Buffer.from("null") },
  ])
    assert.throws(
      () => verifyComfyMaterialUploadAcknowledgement(p, wrong),
      /comfyui_material_upload_acknowledgement_invalid/u,
    );
});

test("target proof requires actual exact bytes, valid PNG and dimensions, not just receipt or file name", () => {
  const q = fixture(),
    p = renderComfyMaterialUpload(q),
    r = {
      status: 200,
      headers: {
        "content-type": "image/png",
        "content-length": String(q.content.bytes.length),
      },
      body: q.content.bytes,
    };
  assert.deepEqual(verifyComfyMaterialTargetBytes(p, r), {
    byteDigest: sha(q.content.bytes),
    byteLength: q.content.bytes.length,
    width: 2,
    height: 1,
  });
  const changed = Buffer.from(q.content.bytes);
  changed[40] = 123;
  for (const wrong of [
    { ...r, status: 404 },
    { ...r, headers: { ...r.headers, "content-type": "image/jpeg" } },
    { ...r, headers: { ...r.headers, "content-encoding": "gzip" } },
    {
      ...r,
      headers: {
        ...r.headers,
        "content-length": `0${r.headers["content-length"]}`,
      },
    },
    { ...r, headers: { ...r.headers, "content-length": "999" } },
    { ...r, body: changed },
    { ...r, body: materialPng(1, 2) },
    { ...r, body: Buffer.alloc(1) },
  ])
    assert.throws(() => verifyComfyMaterialTargetBytes(p, wrong));
});

test("workflow API uploads one exact uniquely named input file and validates its own namespace before byte proof", async () => {
  const q = fixture();
  const p = renderComfyMaterialUpload({
    ...q,
    adapter: "comfyui-workflow-file-upload.v1",
  });
  assert.equal(p.request.path, "/api/comfy/upload/file");
  assert.equal(p.output.type, "input");
  assert.equal(p.output.subfolder, "");
  assert.equal(
    p.output.filename,
    `material-${preparationId}-${q.content.record.source.byteDigest.slice(7)}.png`,
  );
  const form = await new Request(new URL(p.request.path, p.origin), {
    method: "POST",
    headers: p.request.headers,
    body: Buffer.from(p.request.body),
  }).formData();
  const names: string[] = [];
  form.forEach((_value, name) => names.push(name));
  assert.deepEqual(names, ["overwrite", "file"]);
  assert.equal(form.get("overwrite"), "false");
  const file = form.get("file") as File;
  assert.equal(file.name, p.output.filename);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), q.content.bytes);
  assert.equal(new URL(p.viewPath, p.origin).pathname, "/api/comfy/view");
  assert.equal(new URL(p.viewPath, p.origin).searchParams.get("type"), "input");
  assert.doesNotThrow(() =>
    verifyComfyMaterialUploadAcknowledgement(p, acknowledgement(p)),
  );
  for (const overrides of [
    { type: "output" },
    { name: "renamed.png" },
    { subfolder: "foreign" },
  ])
    assert.throws(() =>
      verifyComfyMaterialUploadAcknowledgement(
        p,
        acknowledgement(p, overrides),
      ),
    );
  const native = renderComfyMaterialUpload(q);
  assert.notEqual(native.requestDigest, p.requestDigest);
  assert.deepEqual(
    renderComfyMaterialUpload({ ...q, adapter: "comfyui-image-upload.v1" }),
    native,
  );
});

test("optional adapter detection never evaluates a caller proxy", () => {
  let traps = 0;
  const value = new Proxy(fixture(), {
    getOwnPropertyDescriptor() {
      traps++;
      throw Error("proxy_trap");
    },
  });
  assert.throws(() => renderComfyMaterialUpload(value), /input_invalid/);
  assert.equal(traps, 0);
});
