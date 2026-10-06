import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import {
  inspectProjectMaterialPng,
  MAX_PROJECT_MATERIAL_BYTES,
} from "./project-material-png.ts";
import {
  materialPng,
  pngSignature,
  pngChunk,
  pngHeader,
} from "./project-material-png.test-support.ts";

test("bounded PNG inspection accepts complete RGB/RGBA scanlines and Comfy metadata", () => {
  for (const color of [2, 6])
    assert.deepEqual(inspectProjectMaterialPng(materialPng(2, 3, color)), {
      width: 2,
      height: 3,
    });
  const image = materialPng();
  const metadata = pngChunk(
    "tEXt",
    Buffer.from('prompt\0{"private":"uninterpreted"}'),
  );
  assert.deepEqual(
    inspectProjectMaterialPng(
      Buffer.concat([image.subarray(0, 33), metadata, image.subarray(33)]),
    ),
    { width: 2, height: 1 },
  );
});

test("signature, CRC, dimensions, unsupported encoding and trailing bytes are rejected", () => {
  const corrupted = materialPng();
  corrupted[40]! ^= 1;
  const interlace = pngHeader();
  interlace[12] = 1;
  const bits = pngHeader();
  bits[8] = 16;
  const build = (header: Buffer) =>
    Buffer.concat([
      pngSignature,
      pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(Buffer.alloc(7))),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
  for (const b of [
    Buffer.from("not a png"),
    corrupted,
    materialPng().subarray(0, 40),
    Buffer.concat([materialPng(), Buffer.from("tail")]),
    build(pngHeader(0, 1)),
    build(pngHeader(4097, 1)),
    build(pngHeader(1, 1, 3)),
    build(interlace),
    build(bits),
    Buffer.alloc(MAX_PROJECT_MATERIAL_BYTES + 1),
  ])
    assert.throws(() => inspectProjectMaterialPng(b), /png_invalid/u);
});

test("valid chunk CRCs cannot hide broken zlib, incorrect scanline size or filter values", () => {
  const build = (data: Buffer) =>
    Buffer.concat([
      pngSignature,
      pngChunk("IHDR", pngHeader()),
      pngChunk("IDAT", data),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
  for (const b of [
    Buffer.from("broken"),
    deflateSync(Buffer.alloc(6)),
    deflateSync(Buffer.alloc(8)),
    Buffer.concat([deflateSync(Buffer.alloc(7)), Buffer.from("tail")]),
    deflateSync(Buffer.from([5, 0, 0, 0, 0, 0, 0])),
  ])
    assert.throws(() => inspectProjectMaterialPng(build(b)), /png_invalid/u);
});

test("duplicate headers, nonconsecutive image chunks, critical unknown chunks and animated PNG fail closed", () => {
  const h = pngChunk("IHDR", pngHeader()),
    image = pngChunk("IDAT", deflateSync(Buffer.alloc(7))),
    end = pngChunk("IEND", Buffer.alloc(0));
  for (const middle of [
    [h, image],
    [pngChunk("ABCD", Buffer.alloc(0)), image],
    [pngChunk("acTL", Buffer.alloc(8)), image],
    [image, pngChunk("tEXt", Buffer.from("key\0value")), image],
  ])
    assert.throws(
      () =>
        inspectProjectMaterialPng(
          Buffer.concat([pngSignature, h, ...middle, end]),
        ),
      /png_invalid/u,
    );
});
