import { createHash } from "node:crypto";

import { validateToolExecutionCommand } from "@crewon/tool-broker";

import type {
  McpMutationExecution,
  McpMutationProviderPort,
  McpMutationResolution,
  McpToolCallResult,
} from "./mcp-client-port.ts";

const SCHEMA_VERSION = "crewon.remote-mcp-mutation.v1";
const MAX_RESPONSE_BYTES = 256 * 1024;
const RECEIPT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;
const COMMAND_KEYS = [
  "schemaVersion",
  "executionId",
  "executionLease",
  "actionDigest",
  "actionIntent",
  "approvalProof",
  "idempotencyKey",
  "runId",
  "segmentId",
  "callId",
  "kind",
  "name",
  "input",
] as const;
const LEASE_KEYS = [
  "workItemId",
  "stepId",
  "attemptId",
  "leaseId",
  "leaseEpoch",
  "expiresAt",
] as const;
const APPROVAL_KEYS = [
  "schemaVersion",
  "approvalId",
  "actionDigest",
  "policySnapshotId",
  "approvalRevision",
  "decidedAt",
] as const;

type Phase = "execute" | "reconcile" | "cancel";

export type CrewonRemoteMcpMutationHttpRequest = Readonly<{
  endpoint: URL;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  signal: AbortSignal;
}>;

/** Production implementations must validate every DNS answer and pin the socket. */
export interface CrewonRemoteMcpMutationHttpPort {
  post(request: CrewonRemoteMcpMutationHttpRequest): Promise<Response>;
}

export class CrewonRemoteMcpMutationError extends Error {
  readonly code: string;
  readonly certainty: "notSent" | "possiblySent";

  constructor(
    code: string,
    certainty: "notSent" | "possiblySent",
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "CrewonRemoteMcpMutationError";
    this.code = code;
    this.certainty = certainty;
  }
}

/** CrewON-owned HTTPS protocol; this is not a generic MCP transport. */
export class CrewonRemoteMcpMutationProvider
  implements McpMutationProviderPort
{
  readonly #endpoint: URL;
  readonly #authorization: string;
  readonly #deadlineMs: number;
  readonly #http: CrewonRemoteMcpMutationHttpPort;

  constructor(config: {
    endpoint: string | URL;
    auth: Readonly<{ kind: "bearer"; token: string }>;
    deadlineMs?: number;
    network:
      | Readonly<{ mode: "production"; http: CrewonRemoteMcpMutationHttpPort }>
      | Readonly<{
          mode: "standaloneLoopback";
          fetch?: typeof globalThis.fetch;
        }>;
  }) {
    this.#endpoint = validateEndpoint(config.endpoint, config.network.mode);
    this.#authorization = validateBearer(config.auth.token);
    this.#deadlineMs = boundedInteger(config.deadlineMs ?? 30_000, 1, 60_000);
    this.#http =
      config.network.mode === "production"
        ? config.network.http
        : new StandaloneLoopbackHttpPort(
            config.network.fetch ?? globalThis.fetch,
          );
  }

  execute(execution: McpMutationExecution, signal: AbortSignal) {
    return this.#invoke("execute", execution, signal);
  }

  reconcile(execution: McpMutationExecution, signal: AbortSignal) {
    return this.#invoke("reconcile", execution, signal);
  }

  cancel(execution: McpMutationExecution, signal: AbortSignal) {
    return this.#invoke("cancel", execution, signal);
  }

  async #invoke(
    phase: Phase,
    execution: McpMutationExecution,
    signal: AbortSignal,
  ): Promise<McpMutationResolution> {
    if (signal.aborted) throw failure("remote_mcp_mutation_aborted", "notSent");
    let body: string;
    try {
      validateExecution(execution);
      body = canonicalJson({
        schemaVersion: SCHEMA_VERSION,
        phase,
        providerExecutionId: execution.providerExecutionId,
        toolName: execution.toolName,
        command: execution.command,
      });
    } catch (error) {
      throw error instanceof CrewonRemoteMcpMutationError
        ? error
        : failure("remote_mcp_mutation_preflight_invalid", "notSent");
    }
    const headers: Record<string, string> = {
      "accept": "application/json",
      "content-type": "application/json; charset=utf-8",
      "idempotency-key": `crewon-mcp-v1-${createHash("sha256").update(body).digest("hex")}`,
      "authorization": this.#authorization,
    };
    const deadline = AbortSignal.timeout(this.#deadlineMs);
    const combined = AbortSignal.any([signal, deadline]);
    const abortRace = abortPromise(combined);
    let response: Response;
    try {
      response = await Promise.race([
        this.#http.post({
          endpoint: new URL(this.#endpoint.href),
          headers,
          body: Buffer.from(body, "utf8"),
          signal: combined,
        }),
        abortRace.promise,
      ]);
    } catch (error) {
      abortRace.cleanup();
      throw failure(
        signal.aborted
          ? "remote_mcp_mutation_aborted"
          : deadline.aborted
            ? "remote_mcp_mutation_deadline_exceeded"
            : "remote_mcp_mutation_transport_failed",
        "possiblySent",
      );
    }
    try {
      if (response.status >= 300 && response.status < 400) {
        throw failure("remote_mcp_mutation_redirect_rejected", "possiblySent");
      }
      if (!isJson(response.headers.get("content-type"))) {
        throw failure("remote_mcp_mutation_non_json_response", "possiblySent");
      }
      const bytes = await readBounded(response, abortRace, signal, deadline);
      if (response.status !== 200) {
        throw failure("remote_mcp_mutation_remote_error", "possiblySent");
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        throw failure("remote_mcp_mutation_invalid_json", "possiblySent");
      }
      return parseResponse(decoded, phase, execution);
    } catch (error) {
      throw error instanceof CrewonRemoteMcpMutationError
        ? error
        : failure("remote_mcp_mutation_response_failed", "possiblySent");
    } finally {
      abortRace.cleanup();
    }
  }
}

class StandaloneLoopbackHttpPort implements CrewonRemoteMcpMutationHttpPort {
  readonly #fetch: typeof globalThis.fetch;

  constructor(fetch: typeof globalThis.fetch) {
    this.#fetch = fetch;
  }

  post(request: CrewonRemoteMcpMutationHttpRequest): Promise<Response> {
    return this.#fetch(request.endpoint, {
      method: "POST",
      headers: request.headers,
      body: Buffer.from(request.body),
      redirect: "manual",
      signal: request.signal,
    });
  }
}

function validateEndpoint(
  input: string | URL,
  mode: "production" | "standaloneLoopback",
): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(input);
  } catch {
    throw failure("remote_mcp_mutation_endpoint_invalid", "notSent");
  }
  const rawLoopback =
    /^127(?:\.\d{1,3}){3}$/u.test(endpoint.hostname) &&
    endpoint.hostname.split(".").every((part) => Number(part) <= 255);
  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    (mode === "production"
      ? endpoint.protocol !== "https:"
      : endpoint.protocol !== "http:" || !rawLoopback)
  ) {
    throw failure("remote_mcp_mutation_endpoint_invalid", "notSent");
  }
  return new URL(endpoint.href);
}

function validateBearer(token: string): string {
  if (
    typeof token !== "string" ||
    token.length < 1 ||
    token.length > 4096 ||
    !/^[\x21-\x7e]+$/u.test(token)
  ) {
    throw failure("remote_mcp_mutation_credential_invalid", "notSent");
  }
  return `Bearer ${token}`;
}

function validateExecution(execution: McpMutationExecution): void {
  if (
    !isObject(execution) ||
    !exactKeys(execution, ["providerExecutionId", "toolName", "command"])
  ) {
    throw failure("remote_mcp_mutation_execution_invalid", "notSent");
  }
  if (
    !isObject(execution.command) ||
    !exactKeys(execution.command, COMMAND_KEYS) ||
    !isObject(execution.command.executionLease) ||
    !exactKeys(execution.command.executionLease, LEASE_KEYS) ||
    (execution.command.approvalProof !== null &&
      (!isObject(execution.command.approvalProof) ||
        !exactKeys(execution.command.approvalProof, APPROVAL_KEYS)))
  ) {
    throw failure("remote_mcp_mutation_command_shape_invalid", "notSent");
  }
  validateToolExecutionCommand(execution.command);
  if (
    execution.providerExecutionId !== execution.command.executionId ||
    !TOOL_NAME_PATTERN.test(execution.toolName)
  ) {
    throw failure("remote_mcp_mutation_identity_invalid", "notSent");
  }
}

function parseResponse(
  value: unknown,
  phase: Phase,
  execution: McpMutationExecution,
): McpMutationResolution {
  if (
    !isObject(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "phase",
      "providerExecutionId",
      "toolName",
      "resolution",
    ]) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    value.phase !== phase ||
    value.providerExecutionId !== execution.providerExecutionId ||
    value.toolName !== execution.toolName ||
    !isObject(value.resolution)
  ) {
    throw failure(
      "remote_mcp_mutation_response_identity_invalid",
      "possiblySent",
    );
  }
  const resolution = value.resolution;
  if (resolution.status === "completed") {
    if (
      !exactKeys(resolution, ["status", "providerReceiptId", "result"]) ||
      typeof resolution.providerReceiptId !== "string" ||
      !RECEIPT_PATTERN.test(resolution.providerReceiptId) ||
      !validResult(resolution.result)
    ) {
      throw failure("remote_mcp_mutation_response_invalid", "possiblySent");
    }
    return structuredClone(resolution) as McpMutationResolution;
  }
  if (
    (resolution.status !== "canceled" &&
      resolution.status !== "unknownOutcome") ||
    !exactKeys(resolution, ["status", "providerReceiptId"]) ||
    (resolution.providerReceiptId !== null &&
      (typeof resolution.providerReceiptId !== "string" ||
        !RECEIPT_PATTERN.test(resolution.providerReceiptId)))
  ) {
    throw failure("remote_mcp_mutation_response_invalid", "possiblySent");
  }
  return structuredClone(resolution) as McpMutationResolution;
}

function validResult(value: unknown): value is McpToolCallResult {
  if (
    !isObject(value) ||
    !onlyKeys(value, ["content", "structuredContent", "isError", "toolResult"])
  )
    return false;
  if ("content" in value && !Array.isArray(value.content)) return false;
  if ("structuredContent" in value && !isObject(value.structuredContent))
    return false;
  if ("isError" in value && typeof value.isError !== "boolean") return false;
  try {
    JSON.stringify(value);
  } catch {
    return false;
  }
  return true;
}

async function readBounded(
  response: Response,
  abortRace: ReturnType<typeof abortPromise>,
  external: AbortSignal,
  deadline: AbortSignal,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
  ) {
    await response.body?.cancel();
    throw failure("remote_mcp_mutation_response_too_large", "possiblySent");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await Promise.race([reader.read(), abortRace.promise]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw failure("remote_mcp_mutation_response_too_large", "possiblySent");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof CrewonRemoteMcpMutationError) throw error;
    if (external.aborted)
      throw failure("remote_mcp_mutation_aborted", "possiblySent");
    if (deadline.aborted)
      throw failure("remote_mcp_mutation_deadline_exceeded", "possiblySent");
    throw failure("remote_mcp_mutation_response_failed", "possiblySent");
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function abortPromise(
  signal: AbortSignal,
): Readonly<{ promise: Promise<never>; cleanup(): void }> {
  let rejectPromise: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    rejectPromise = reject;
  });
  const onAbort = () => rejectPromise(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return {
    promise,
    cleanup: () => signal.removeEventListener("abort", onAbort),
  };
}

function isJson(value: string | null): boolean {
  return value !== null && /^application\/json(?:\s*;|$)/iu.test(value);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    [...keys].sort().every((key, index) => actual[index] === key)
  );
}
function onlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const visit = (current: unknown, depth: number): string => {
    if (depth > 64) throw new TypeError("canonical_json_too_deep");
    if (
      current === null ||
      typeof current === "boolean" ||
      typeof current === "string"
    ) {
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current))
        throw new TypeError("canonical_json_number_invalid");
      return JSON.stringify(current);
    }
    if (!Array.isArray(current) && !isObject(current)) {
      throw new TypeError("canonical_json_value_invalid");
    }
    if (ancestors.has(current)) throw new TypeError("canonical_json_cycle");
    ancestors.add(current);
    const serialized = Array.isArray(current)
      ? `[${current.map((item) => visit(item, depth + 1)).join(",")}]`
      : `{${Object.keys(current)
          .sort()
          .map(
            (key) => `${JSON.stringify(key)}:${visit(current[key], depth + 1)}`,
          )
          .join(",")}}`;
    ancestors.delete(current);
    return serialized;
  };
  return visit(value, 0);
}
function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw failure("remote_mcp_mutation_deadline_invalid", "notSent");
  return value;
}
function failure(code: string, certainty: "notSent" | "possiblySent") {
  return new CrewonRemoteMcpMutationError(code, certainty);
}
