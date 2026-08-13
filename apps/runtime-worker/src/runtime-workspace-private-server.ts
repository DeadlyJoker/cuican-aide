import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  ContractValidationError,
  WORKSPACE_NATIVE_READONLY_LIMITS,
  WORKSPACE_NATIVE_READONLY_PATH,
  RUNTIME_WORKER_WORKSPACE_API_VERSION,
  RUNTIME_WORKER_WORKSPACE_DISPATCH_PATH,
  RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH,
  RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS,
  parseRuntimeWorkerWorkspaceDispatchRequest,
  parseRuntimeWorkerWorkspaceDispatchError,
  parseRuntimeWorkerWorkspaceDispatchResponse,
  parseRuntimeWorkerWorkspaceFreezeCommandError,
  parseRuntimeWorkerWorkspaceFreezeCommandRequest,
  parseRuntimeWorkerWorkspaceFreezeCommandResponse,
  parseWorkspaceNativeReadonlyRequest,
  parseWorkspaceNativeReadonlyResponse,
  type RuntimeWorkerWorkspaceDispatchError,
  type RuntimeWorkerWorkspaceDispatchRequest,
  type RuntimeWorkerWorkspaceFreezeCommandError,
  type RuntimeWorkerWorkspacePhase,
} from "@crewon/contracts";

import type { RuntimeWorkspaceDispatchService } from "./runtime-workspace-dispatch-service.ts";
import { RuntimeWorkspaceError } from "./runtime-workspace-error.ts";
import type { RuntimeWorkspaceFreezeService } from "./runtime-workspace-freeze-service.ts";
import type { RuntimeNativeReadonlyService } from "./runtime-native-readonly.ts";

/** Team authentication is intentionally absent until a real mTLS server exists. */
export type RuntimeWorkspacePrivateAuthentication = Readonly<{
  kind: "loopbackToken";
  token: string;
}>;

export type RuntimeWorkspacePrivateServer = Readonly<{
  origin: string;
  close(): Promise<void>;
}>;

/** Hosts only the frozen Workspace private contract on an authenticated boundary. */
export async function startRuntimeWorkspacePrivateServer(config: {
  port: number;
  authentication: RuntimeWorkspacePrivateAuthentication;
  freeze: Pick<RuntimeWorkspaceFreezeService, "freeze">;
  dispatch: Pick<RuntimeWorkspaceDispatchService, "dispatch">;
  readonly?: Pick<RuntimeNativeReadonlyService, "execute">;
  deadlineMs?: number;
}): Promise<RuntimeWorkspacePrivateServer> {
  const port = validPort(config.port);
  const deadlineMs = boundedInteger(
    config.deadlineMs ?? 35_000,
    1_000,
    60_000,
    "runtime_workspace_server_deadline_invalid",
  );
  const authentication = validateAuthentication(config.authentication);
  const server = createServer((request, response) => {
    void handleRequest(
      request,
      response,
      authentication,
      config.freeze,
      config.dispatch,
      config.readonly,
      deadlineMs,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new RuntimeWorkspaceError("runtime_workspace_server_address_invalid");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  authentication: RuntimeWorkspacePrivateAuthentication,
  freeze: Pick<RuntimeWorkspaceFreezeService, "freeze">,
  dispatch: Pick<RuntimeWorkspaceDispatchService, "dispatch">,
  readonly: Pick<RuntimeNativeReadonlyService, "execute"> | undefined,
  deadlineMs: number,
): Promise<void> {
  if (
    request.method !== "POST" ||
    (request.url !== RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH &&
      request.url !== RUNTIME_WORKER_WORKSPACE_DISPATCH_PATH &&
      request.url !== WORKSPACE_NATIVE_READONLY_PATH)
  ) {
    writeEmpty(response, 404);
    return;
  }
  const controller = new AbortController();
  let requestedPhase: RuntimeWorkerWorkspacePhase | null = null;
  const cancelDeadline = scheduleDeadline(controller, deadlineMs);
  const cleanupDisconnect = bindDisconnect(request, response, controller);
  try {
    authenticate(request, authentication);
    requireJsonContentType(request.headers["content-type"]);
    const isReadonly = request.url === WORKSPACE_NATIVE_READONLY_PATH;
    if (isReadonly && readonly === undefined) {
      writeEmpty(response, 404);
      return;
    }
    const isFreeze =
      request.url === RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH;
    const body = await readJson(
      request,
      isReadonly
        ? WORKSPACE_NATIVE_READONLY_LIMITS.requestBytes
        : isFreeze
          ? RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.freezeRequestBytes
          : RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.dispatchRequestBytes,
    );
    if (isReadonly) {
      const input = parseWorkspaceNativeReadonlyRequest(body);
      const result = await readonly!.execute(input, controller.signal);
      const output = parseWorkspaceNativeReadonlyResponse(result, input);
      if (!response.destroyed) writeJson(response, 200, output);
      return;
    }
    if (isFreeze) {
      const input = parseRuntimeWorkerWorkspaceFreezeCommandRequest(body);
      const result = await freeze.freeze(input, controller.signal);
      const output = parseRuntimeWorkerWorkspaceFreezeCommandResponse(
        result,
        input,
      );
      if (!response.destroyed) writeJson(response, 200, output);
      return;
    }
    const input = parseRuntimeWorkerWorkspaceDispatchRequest(body);
    requestedPhase = input.phase;
    const result = await dispatch.dispatch(input, controller.signal);
    const output = parseRuntimeWorkerWorkspaceDispatchResponse(result, input);
    if (!response.destroyed) writeJson(response, 200, output);
  } catch (error) {
    if (response.destroyed) return;
    if (error instanceof AuthenticationError) {
      writeEmpty(response, 401);
      return;
    }
    if (request.url === WORKSPACE_NATIVE_READONLY_PATH) {
      const projection = errorProjection(error);
      writeJson(response, projection.status, { code: projection.code });
      return;
    }
    if (request.url === RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH) {
      writeFreezeError(response, error);
      return;
    }
    if (requestedPhase === null) {
      writeEmpty(
        response,
        error instanceof ContractValidationError ? 400 : 503,
      );
      return;
    }
    writeDispatchError(response, requestedPhase, error);
  } finally {
    cancelDeadline();
    cleanupDisconnect();
  }
}

function authenticate(
  request: IncomingMessage,
  authentication: RuntimeWorkspacePrivateAuthentication,
): void {
  if (
    !loopbackPeer(request.socket.remoteAddress) ||
    !authorized(request.headers.authorization, authentication.token)
  ) {
    throw new AuthenticationError();
  }
}

async function readJson(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<unknown> {
  const contentLength = request.headers["content-length"];
  if (
    contentLength !== undefined &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumBytes)
  ) {
    throw new ContractValidationError("runtime_workspace_request_too_large");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximumBytes) {
      throw new ContractValidationError("runtime_workspace_request_too_large");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch {
    throw new ContractValidationError("runtime_workspace_request_json_invalid");
  }
}

function writeFreezeError(response: ServerResponse, error: unknown): void {
  const projection = errorProjection(error);
  try {
    const body = parseRuntimeWorkerWorkspaceFreezeCommandError({
      schemaVersion: "crewon.runtime-worker-workspace-freeze-error.v0",
      apiVersion: RUNTIME_WORKER_WORKSPACE_API_VERSION,
      code: projection.code,
      retryable: projection.retryable,
      certainty: "notSent",
    } satisfies RuntimeWorkerWorkspaceFreezeCommandError);
    writeJson(response, projection.status, body);
  } catch {
    writeJson(response, 503, unavailableFreezeError());
  }
}

function writeDispatchError(
  response: ServerResponse,
  phase: RuntimeWorkerWorkspacePhase,
  error: unknown,
): void {
  const projection = errorProjection(error);
  try {
    const body = parseRuntimeWorkerWorkspaceDispatchError(
      {
        schemaVersion: "crewon.runtime-worker-workspace-dispatch-error.v0",
        apiVersion: RUNTIME_WORKER_WORKSPACE_API_VERSION,
        phase,
        code: projection.code,
        retryable: projection.retryable,
        certainty: projection.certainty,
      } satisfies RuntimeWorkerWorkspaceDispatchError,
      phase,
    );
    writeJson(response, projection.status, body);
  } catch {
    writeJson(
      response,
      503,
      unavailableDispatchError(phase, projection.certainty),
    );
  }
}

function unavailableFreezeError(): RuntimeWorkerWorkspaceFreezeCommandError {
  return parseRuntimeWorkerWorkspaceFreezeCommandError({
    schemaVersion: "crewon.runtime-worker-workspace-freeze-error.v0",
    apiVersion: RUNTIME_WORKER_WORKSPACE_API_VERSION,
    code: "runtime_workspace_unavailable",
    retryable: true,
    certainty: "notSent",
  });
}

function unavailableDispatchError(
  phase: RuntimeWorkerWorkspacePhase,
  certainty: "notSent" | "possiblySent",
): RuntimeWorkerWorkspaceDispatchError {
  return parseRuntimeWorkerWorkspaceDispatchError(
    {
      schemaVersion: "crewon.runtime-worker-workspace-dispatch-error.v0",
      apiVersion: RUNTIME_WORKER_WORKSPACE_API_VERSION,
      phase,
      code: "runtime_workspace_unavailable",
      retryable: true,
      certainty,
    },
    phase,
  );
}

function errorProjection(error: unknown): Readonly<{
  status: number;
  code: string;
  retryable: boolean;
  certainty: "notSent" | "possiblySent";
}> {
  if (error instanceof ContractValidationError) {
    return {
      status: 400,
      code: error.code,
      retryable: false,
      certainty: "notSent",
    };
  }
  if (error instanceof RuntimeWorkspaceError) {
    const conflict =
      error.code === "runtime_workspace_digest_mismatch" ||
      error.code === "runtime_workspace_binding_mismatch" ||
      error.code === "runtime_workspace_binding_drift";
    return {
      status: conflict ? 409 : 503,
      code: error.code,
      retryable: error.retryable,
      certainty: error.certainty,
    };
  }
  return {
    status: 503,
    code: "runtime_workspace_unavailable",
    retryable: true,
    certainty: "notSent",
  };
}

function validateAuthentication(
  input: unknown,
): Readonly<{ kind: "loopbackToken"; token: string }> {
  if (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    Object.keys(input).sort().join("\0") === "kind\0token" &&
    "kind" in input &&
    input.kind === "loopbackToken" &&
    "token" in input &&
    typeof input.token === "string"
  ) {
    return { kind: "loopbackToken", token: validToken(input.token) };
  }
  throw new RuntimeWorkspaceError(
    "runtime_workspace_authentication_unavailable",
  );
}

function authorized(value: string | undefined, token: string): boolean {
  if (value?.startsWith("Bearer ") !== true) return false;
  const supplied = Buffer.from(value.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

function requireJsonContentType(value: string | undefined): void {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(value ?? "")) {
    throw new ContractValidationError("runtime_workspace_content_type_invalid");
  }
}

function bindDisconnect(
  request: IncomingMessage,
  response: ServerResponse,
  controller: AbortController,
): () => void {
  const abort = () => {
    if (!response.writableEnded) {
      controller.abort(new RuntimeWorkspaceError("runtime_workspace_aborted"));
    }
  };
  request.once("aborted", abort);
  response.once("close", abort);
  request.socket.once("close", abort);
  return () => {
    request.off("aborted", abort);
    response.off("close", abort);
    request.socket.off("close", abort);
  };
}

function scheduleDeadline(
  controller: AbortController,
  deadlineMs: number,
): () => void {
  const timer = setTimeout(
    () =>
      controller.abort(
        new RuntimeWorkspaceError("runtime_workspace_deadline_exceeded", {
          retryable: true,
        }),
      ),
    deadlineMs,
  );
  timer.unref();
  return () => clearTimeout(timer);
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(body.byteLength),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function writeEmpty(response: ServerResponse, status: number): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": "0",
  });
  response.end();
}

function validPort(value: number): number {
  return boundedInteger(value, 0, 65_535, "runtime_workspace_port_invalid");
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RuntimeWorkspaceError(code);
  }
  return value;
}

function validToken(value: string): string {
  if (
    Buffer.byteLength(value) < 32 ||
    Buffer.byteLength(value) > 8_192 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RuntimeWorkspaceError("runtime_workspace_token_invalid");
  }
  return value;
}

function loopbackPeer(value: string | undefined): boolean {
  return (
    value === "127.0.0.1" || value === "::ffff:127.0.0.1" || value === "::1"
  );
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

class AuthenticationError extends Error {}
