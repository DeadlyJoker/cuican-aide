import { types } from "node:util";

const byteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)!.get!;
const set = Uint8Array.prototype.set;

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
