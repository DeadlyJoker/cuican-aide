import { crc32, inflateSync } from "node:zlib";

export const MAX_PROJECT_MATERIAL_BYTES = 16 * 1024 * 1024;
const MAX_DIMENSION = 4096;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** The reviewed Comfy SaveImage path produces non-interlaced 8-bit RGB/RGBA PNG.
 * Verify chunks, compressed scanline length and filters without interpreting ancillary metadata.
 * This is a technical format check, never a visual quality or execution authority claim.
 */
export function inspectProjectMaterialPng(
  input: Uint8Array,
): Readonly<{ width: number; height: number }> {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength > MAX_PROJECT_MATERIAL_BYTES ||
    input.byteLength < 57
  )
    invalid();
  const b = Buffer.from(input);
  if (!b.subarray(0, 8).equals(signature)) invalid();
  let offset = 8,
    chunks = 0,
    width = 0,
    height = 0,
    channels = 0,
    ended = false,
    imageStarted = false,
    imageClosed = false,
    palette = false;
  const image: Buffer[] = [];
  while (offset < b.length) {
    if (++chunks > 4096 || b.length - offset < 12) invalid();
    const length = b.readUInt32BE(offset),
      end = offset + 12 + length;
    if (end > b.length) invalid();
    const name = b.toString("latin1", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/u.test(name) || !/[A-Z]/u.test(name[2]!)) invalid();
    const data = b.subarray(offset + 8, end - 4);
    if (crc32(b.subarray(offset + 4, end - 4)) !== b.readUInt32BE(end - 4))
      invalid();
    if (chunks === 1 && name !== "IHDR") invalid();
    if (name === "IHDR") {
      if (chunks !== 1 || length !== 13) invalid();
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (
        width < 1 ||
        height < 1 ||
        width > MAX_DIMENSION ||
        height > MAX_DIMENSION ||
        data[8] !== 8 ||
        (data[9] !== 2 && data[9] !== 6) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      )
        invalid();
      channels = data[9] === 2 ? 3 : 4;
    } else if (name === "IDAT") {
      if (imageClosed) invalid();
      imageStarted = true;
      image.push(data);
    } else if (name === "IEND") {
      if (!imageStarted || length !== 0 || end !== b.length) invalid();
      ended = true;
    } else {
      if (imageStarted) imageClosed = true;
      if (name === "PLTE") {
        if (
          palette ||
          imageStarted ||
          length < 3 ||
          length > 768 ||
          length % 3 !== 0
        )
          invalid();
        palette = true;
      } else if (name[0] === name[0]!.toUpperCase()) invalid();
      // APNG is not a still reference; no hidden frames are accepted.
      if (["acTL", "fcTL", "fdAT"].includes(name)) invalid();
    }
    offset = end;
  }
  if (!ended || image.length === 0) invalid();
  const stride = width * channels + 1,
    expected = stride * height;
  let pixels: Buffer;
  try {
    const compressed = Buffer.concat(image);
    // Node's info:true result is an envelope; the current @types overload still declares Buffer.
    const result = inflateSync(compressed, {
      maxOutputLength: expected,
      info: true,
    }) as unknown as {
      buffer: Buffer;
      engine: Readonly<{ bytesWritten: number }>;
    };
    if (
      !Buffer.isBuffer(result.buffer) ||
      result.engine.bytesWritten !== compressed.length
    )
      invalid();
    pixels = result.buffer;
  } catch {
    invalid();
  }
  if (pixels!.length !== expected) invalid();
  for (let y = 0; y < height; y++) if (pixels![y * stride]! > 4) invalid();
  return Object.freeze({ width, height });
}

function invalid(): never {
  throw new Error("project_reference_material_png_invalid");
}
