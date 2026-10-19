import { spawn } from "node:child_process";

let occupied = false;

/** Shared by image conversion and video inspection; admission never creates a queue. */
export function acquireMediaInspectionSlot(): (() => void) | null {
  if (occupied) return null;
  occupied = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    occupied = false;
  };
}

export class MediaInspectionProcessError extends Error {
  readonly code:
    | "canceled"
    | "process_failed"
    | "decode_failed"
    | "output_too_large";
  constructor(
    code: "canceled" | "process_failed" | "decode_failed" | "output_too_large",
  ) {
    super(code);
    this.code = code;
  }
}

/** Only host-owned arguments and an authorized snapshot may reach this internal API. */
export function runMediaInspectionProcess(
  input: Readonly<{
    executable: string;
    args: readonly string[];
    source:
      | { kind: "bytes"; bytes: Buffer }
      | { kind: "descriptor"; descriptor: number };
    maxOutputBytes: number;
    signal: AbortSignal;
  }>,
): Promise<Buffer> {
  input.signal.throwIfAborted();
  const env: NodeJS.ProcessEnv = { LANG: "C" };
  if (process.platform === "win32" && process.env.SystemRoot)
    env.SystemRoot = process.env.SystemRoot;
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, [...input.args], {
      stdio:
        input.source.kind === "bytes"
          ? ["pipe", "pipe", "ignore"]
          : ["ignore", "pipe", "ignore", input.source.descriptor],
      env,
      shell: false,
      windowsHide: true,
    });
    let failure: MediaInspectionProcessError | null = null;
    let length = 0;
    const chunks: Buffer[] = [];
    const stop = (code: "canceled" | "output_too_large") => {
      failure ??= new MediaInspectionProcessError(code);
      child.kill("SIGKILL");
    };
    const abort = () => stop("canceled");
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    child.on("error", () => {
      failure ??= new MediaInspectionProcessError("process_failed");
    });
    child.stdin?.on("error", () => {});
    child.stdout!.on("data", (chunk: Buffer) => {
      if (failure !== null) return;
      length += chunk.length;
      if (length > input.maxOutputBytes) {
        stop("output_too_large");
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    // Physical close, including spawn failure, owns both settlement and capacity release.
    child.on("close", (code) => {
      input.signal.removeEventListener("abort", abort);
      if (failure !== null) reject(failure);
      else if (code !== 0)
        reject(new MediaInspectionProcessError("decode_failed"));
      else resolve(Buffer.concat(chunks, length));
    });
    if (input.source.kind === "bytes") child.stdin!.end(input.source.bytes);
  });
}
