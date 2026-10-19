import { types } from "node:util";

const byteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)!.get!;
const set = Uint8Array.prototype.set;
const buffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "buffer",
)!.get!;
const byteOffset = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteOffset",
)!.get!;

/** Native view length and copy, without invoking caller-supplied length/offset/iterator accessors. */
export function materialByteLength(input: unknown): number {
  if (types.isProxy(input) || !(input instanceof Uint8Array))
    throw new Error("material_bytes_invalid");
  return byteLength.call(input) as number;
}

export function copyBoundedMaterialBytes(
  input: unknown,
  options: Readonly<{ maxBytes: number; expectedBytes: number | null }>,
): Buffer {
  const length = materialByteLength(input);
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 0 ||
    options.maxBytes > 16 * 1024 * 1024 + 64 * 1024 ||
    length > options.maxBytes ||
    (options.expectedBytes !== null && length !== options.expectedBytes)
  )
    throw new Error("material_bytes_invalid");
  const bytes = Buffer.alloc(length);
  set.call(bytes, input as Uint8Array);
  return bytes;
}

/** Bounded native slices for large media; never calls an input's subarray/species/getters. */
export function copyMaterialByteChunk(
  input: unknown,
  start: number,
  length: number,
): Buffer {
  const total = materialByteLength(input);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(length) ||
    start < 0 ||
    length < 1 ||
    length > 64 * 1024 ||
    start + length > total
  )
    throw new Error("material_bytes_invalid");
  const source = new Uint8Array(
    buffer.call(input),
    byteOffset.call(input) + start,
    length,
  );
  const result = Buffer.alloc(length);
  set.call(result, source);
  return result;
}
