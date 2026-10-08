import { transferableAbortController } from "node:util";

// Happy DOM synthesizes AbortSignal fields. Installed SDK clients intentionally require the
// native Web API brand; use Node 24's genuine Web implementation rather than weakening it.
if (
  Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get ===
  undefined
) {
  const native = transferableAbortController();
  Object.defineProperties(globalThis, {
    AbortController: {
      value: Object.getPrototypeOf(native).constructor,
      configurable: true,
      writable: true,
    },
    AbortSignal: {
      value: Object.getPrototypeOf(native.signal).constructor,
      configurable: true,
      writable: true,
    },
  });
}
