// The reusable worker intentionally `unref()`s its scan timer so library users
// are not forced to keep a process alive. A packaged desktop worker is itself a
// supervised daemon, so retain the host-owned stdin pipe after initialization.
// The pipe closes with the Tauri parent even if normal shutdown cannot run.
import { installRuntimeNativeBootstrap } from "../../../runtime-worker/src/runtime-native-bootstrap.ts";

const MAX_BOOTSTRAP_BYTES = 512 * 1024;
const bytes = await readBootstrapLine();
try {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("runtime_native_bootstrap_invalid");
  }
  installRuntimeNativeBootstrap(value);
} finally {
  bytes.fill(0);
}

await import("../../../runtime-worker/src/main.ts");
process.stdin.resume();

function readBootstrapLine() {
  return new Promise((resolve, reject) => {
    const storage = Buffer.allocUnsafe(MAX_BOOTSTRAP_BYTES);
    let length = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      process.stdin.pause();
      if (error === null) resolve(value);
      else {
        storage.fill(0, 0, length);
        reject(error);
      }
    };
    const onData = (chunk) => {
      const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const newline = input.indexOf(0x0a);
      const body = newline === -1 ? input : input.subarray(0, newline);
      if (length + body.byteLength > MAX_BOOTSTRAP_BYTES) {
        input.fill(0);
        finish(new Error("runtime_native_bootstrap_invalid"));
        return;
      }
      const invalidTrailing =
        newline !== -1 &&
        input
          .subarray(newline + 1)
          .some((byte) => ![0x09, 0x0d, 0x20].includes(byte));
      body.copy(storage, length);
      length += body.byteLength;
      input.fill(0);
      if (invalidTrailing) {
        finish(new Error("runtime_native_bootstrap_invalid"));
        return;
      }
      if (newline !== -1) {
        finish(
          length === 0 ? new Error("runtime_native_bootstrap_required") : null,
          storage.subarray(0, length),
        );
      }
    };
    const onEnd = () =>
      finish(
        length === 0 ? new Error("runtime_native_bootstrap_required") : null,
        storage.subarray(0, length),
      );
    const onError = () => finish(new Error("runtime_native_bootstrap_invalid"));
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
    process.stdin.resume();
  });
}
