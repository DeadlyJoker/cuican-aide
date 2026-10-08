import { PROJECT_SOURCE_UPLOAD_PART_BYTES } from "../../contracts/src/project-source-uploads.ts";
import { fail } from "./definition-validation.js";

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const nativeLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)!.get!;
const nativeOffset = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteOffset",
)!.get!;
const nativeBuffer = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer",
)!.get!;
const nativeTag = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag,
)!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)!.get!;
const nativeSet = Uint8Array.prototype.set;

/** Snapshot at most one native part before any asynchronous transport; shared, detached and fake bytes are rejected. */
export function captureSourceUploadPartBytes(input: Uint8Array): Uint8Array {
  try {
    if (nativeTag.call(input) !== "Uint8Array") invalid();
    const length: number = nativeLength.call(input);
    if (length < 1 || length > PROJECT_SOURCE_UPLOAD_PART_BYTES) invalid();
    const buffer: ArrayBuffer = nativeBuffer.call(input);
    arrayBufferLength.call(buffer); // Reject SharedArrayBuffer without reading user getters.
    const view = new Uint8Array(buffer, nativeOffset.call(input), length);
    const snapshot = new Uint8Array(length);
    nativeSet.call(snapshot, view);
    return snapshot;
  } catch {
    return invalid();
  }
}
function invalid(): never {
  return fail("plugin_project_source_upload_part_bytes_invalid");
}
