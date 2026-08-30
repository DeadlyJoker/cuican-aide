import { installRuntimeNativeBootstrap } from "./runtime-native-bootstrap.ts";

const MAX_BOOTSTRAP_BYTES = 512 * 1024;

/** Reads, installs, and zeroizes the desktop worker's one-shot stdin bootstrap. */
export async function readAndInstallRuntimeNativeBootstrap(): Promise<void> {
  const bytes = await readBootstrapLine();
  try {
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("runtime_native_bootstrap_invalid");
    }
    installRuntimeNativeBootstrap(value);
  } finally {
    bytes.fill(0);
  }
}

export function readBootstrapLine({
  input = process.stdin,
  rejectTrailingInput = rejectDesktopBootstrap,
}: {
  input?: NodeJS.ReadableStream;
  rejectTrailingInput?: (error: Error) => void;
} = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const storage = Buffer.allocUnsafe(MAX_BOOTSTRAP_BYTES);
    let length = 0;
    let settled = false;
    const removeBootstrapListeners = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
    };
    const removeTrailingListeners = () => {
      input.off("data", onTrailingData);
      input.off("end", onTrailingEnd);
      input.off("error", onTrailingError);
    };
    const finish = (error: Error | null, value?: Buffer) => {
      if (settled) return;
      settled = true;
      removeBootstrapListeners();
      if (error === null && value !== undefined) resolve(value);
      else {
        storage.fill(0, 0, length);
        input.pause();
        reject(error ?? new Error("runtime_native_bootstrap_invalid"));
      }
    };
    const onTrailingData = (chunk: Buffer | string) => {
      const trailing = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const invalid = trailing.some(
        (byte) => ![0x09, 0x0d, 0x20].includes(byte),
      );
      trailing.fill(0);
      if (invalid) {
        removeTrailingListeners();
        rejectTrailingInput(new Error("runtime_native_bootstrap_invalid"));
      }
    };
    const onTrailingEnd = () => removeTrailingListeners();
    const onTrailingError = () => {
      removeTrailingListeners();
      rejectTrailingInput(new Error("runtime_native_bootstrap_invalid"));
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const newline = bytes.indexOf(0x0a);
      const body = newline === -1 ? bytes : bytes.subarray(0, newline);
      if (length + body.byteLength > MAX_BOOTSTRAP_BYTES) {
        bytes.fill(0);
        finish(new Error("runtime_native_bootstrap_invalid"));
        return;
      }
      const invalidTrailing =
        newline !== -1 &&
        bytes
          .subarray(newline + 1)
          .some((byte) => ![0x09, 0x0d, 0x20].includes(byte));
      body.copy(storage, length);
      length += body.byteLength;
      bytes.fill(0);
      if (invalidTrailing) {
        finish(new Error("runtime_native_bootstrap_invalid"));
      } else if (newline !== -1) {
        if (length === 0) {
          finish(new Error("runtime_native_bootstrap_required"));
          return;
        }
        removeBootstrapListeners();
        input.on("data", onTrailingData);
        input.once("end", onTrailingEnd);
        input.once("error", onTrailingError);
        finish(null, storage.subarray(0, length));
      }
    };
    const onEnd = () =>
      finish(
        length === 0 ? new Error("runtime_native_bootstrap_required") : null,
        storage.subarray(0, length),
      );
    const onError = () => finish(new Error("runtime_native_bootstrap_invalid"));
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.resume();
  });
}

function rejectDesktopBootstrap(error: Error): void {
  process.stderr.write(`${error.message}\n`, () => process.exit(1));
}
