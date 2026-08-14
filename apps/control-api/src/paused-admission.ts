import type { ErrorEnvelope } from "@crewon/contracts/runtime";

export const PAUSED_ADMISSION_ENV = "CREWON_CONTROL_PAUSED_ADMISSION";
export const ACTIVATION_CONFIRMED_LINE =
  "CrewON Control API activation confirmed";

const ACTIVATION_COMMAND = Buffer.from("activate\n", "utf8");
const HEALTH_PATHS = new Set(["/api/v1/health/live", "/api/v1/health/ready"]);

type Environment = Readonly<Record<string, string | undefined>>;
type AdmissionState = "active" | "failed" | "fenced";
type ActivationInput = Readonly<{
  on(
    event: "data",
    listener: (chunk: string | Buffer | Uint8Array) => void,
  ): void;
  on(event: "end" | "error" | "close", listener: () => void): void;
  off(
    event: "data",
    listener: (chunk: string | Buffer | Uint8Array) => void,
  ): void;
  off(event: "end" | "error" | "close", listener: () => void): void;
}>;
type ActivationOutput = Readonly<{
  write(chunk: string): unknown;
}>;

/** Process-local fence used only while a standalone native candidate is prepared. */
export class ProcessLocalActivationGate {
  #state: AdmissionState = "fenced";

  admitRequest(method: string, url: string): boolean {
    return (
      this.#state === "active" ||
      ((method === "GET" || method === "HEAD") && HEALTH_PATHS.has(url))
    );
  }

  activate(): boolean {
    if (this.#state !== "fenced") return false;
    this.#state = "active";
    return true;
  }

  failClosed(): void {
    this.#state = "failed";
  }

  isActive(): boolean {
    return this.#state === "active";
  }
}

export function resolvePausedAdmission(
  environment: Environment,
  securityMode: "production" | "standalone",
): ProcessLocalActivationGate | null {
  const declared = environment[PAUSED_ADMISSION_ENV] !== undefined;
  if (securityMode === "production") {
    if (declared) throw new Error("CREWON_CONTROL_PAUSED_ADMISSION_forbidden");
    return null;
  }
  if (!declared) return null;
  if (environment[PAUSED_ADMISSION_ENV] !== "1") {
    throw new Error("CREWON_CONTROL_PAUSED_ADMISSION_invalid");
  }
  return new ProcessLocalActivationGate();
}

export function candidateReadinessLine(port: number): string {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("control_candidate_port_invalid");
  }
  return `CrewON Control API candidate ready on 127.0.0.1:${port}`;
}

export function pausedAdmissionResponse(requestId: string): ErrorEnvelope {
  return {
    error: {
      category: "internal",
      code: "control_activation_pending",
      message: "The service is not ready to accept requests.",
      requestId,
    },
  };
}

export type ActivationInputController = Readonly<{ close(): void }>;

/** Reads exactly one bounded activation record without waiting for EOF. */
export function watchActivationInput(
  gate: ProcessLocalActivationGate,
  input: ActivationInput,
  output: ActivationOutput,
  onInvalid: () => void,
): ActivationInputController {
  let buffered = Buffer.alloc(0);
  let closed = false;
  let invalid = false;

  const detach = () => {
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("error", onError);
    input.off("close", onClose);
  };
  const fail = () => {
    if (invalid || closed) return;
    invalid = true;
    gate.failClosed();
    detach();
    onInvalid();
  };
  const onData = (chunk: string | Buffer | Uint8Array) => {
    if (closed || invalid) return;
    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk, "utf8")
        : Buffer.from(chunk);
    if (bytes.byteLength === 0) return;
    if (gate.isActive()) {
      fail();
      return;
    }
    if (
      buffered.byteLength + bytes.byteLength >
      ACTIVATION_COMMAND.byteLength
    ) {
      fail();
      return;
    }
    buffered = Buffer.concat([buffered, bytes]);
    if (!ACTIVATION_COMMAND.subarray(0, buffered.byteLength).equals(buffered)) {
      fail();
      return;
    }
    if (buffered.byteLength !== ACTIVATION_COMMAND.byteLength) return;
    if (!gate.activate()) {
      fail();
      return;
    }
    try {
      output.write(`${ACTIVATION_CONFIRMED_LINE}\n`);
    } catch {
      fail();
    }
  };
  const onEnd = () => {
    if (!gate.isActive()) fail();
  };
  const onError = () => fail();
  const onClose = () => {
    if (!gate.isActive()) fail();
  };

  input.on("data", onData);
  input.on("end", onEnd);
  input.on("error", onError);
  input.on("close", onClose);

  return {
    close() {
      if (closed) return;
      closed = true;
      detach();
    },
  };
}
