import { hasDesktopBridge } from "../platform";
import { requireDesktopBridge } from "./desktopBridge";

const STATUS_SCHEMA_VERSION = "crewon.desktop-workspace-status.v0";
const ERROR_SCHEMA_VERSION = "crewon.desktop-workspace-error.v0";
const STATUS_WIRE_MAX_BYTES = 4 * 1024;
const MUTATION_RESPONSE_WIRE_MAX_BYTES = 8 * 1024;
const ERROR_WIRE_MAX_BYTES = 2 * 1024;
const DISPLAY_NAME_MAX_BYTES = 255;
const IDEMPOTENCY_KEY_MAX_BYTES = 256;
const ERROR_CODE_MAX_BYTES = 128;

export type DesktopWorkspaceAvailability =
  | "available"
  | "transitioning"
  | "unavailable";

export type DesktopWorkspaceStatus = Readonly<{
  schemaVersion: typeof STATUS_SCHEMA_VERSION;
  availability: DesktopWorkspaceAvailability;
  revision: number;
  supervisorGeneration: number;
  current: Readonly<{ displayName: string }> | null;
}>;

export type DesktopWorkspaceMutationRequest = Readonly<{
  expectedRevision: number;
  idempotencyKey: string;
}>;

export type DesktopWorkspaceSelectResponse =
  | Readonly<{
      outcome: "committed";
      snapshot: DesktopWorkspaceStatus;
    }>
  | Readonly<{
      outcome: "userCanceled";
      snapshot: DesktopWorkspaceStatus;
    }>;

export type DesktopWorkspaceClearResponse = Readonly<{
  outcome: "committed";
  snapshot: DesktopWorkspaceStatus;
}>;

export interface DesktopWorkspaceAuthorityPort {
  status(): Promise<DesktopWorkspaceStatus>;
  selectAndRegister(
    request: DesktopWorkspaceMutationRequest,
  ): Promise<DesktopWorkspaceSelectResponse>;
  clear(
    request: DesktopWorkspaceMutationRequest,
  ): Promise<DesktopWorkspaceClearResponse>;
}

type DesktopInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

type DesktopWorkspaceNativeErrorWire = Readonly<{
  schemaVersion: typeof ERROR_SCHEMA_VERSION;
  status: number;
  code: string;
  certainty: "notSent" | "possiblySent";
}>;

export class DesktopWorkspaceProtocolError extends Error {
  constructor(code = "desktop_workspace_protocol_invalid") {
    super(code);
    this.name = "DesktopWorkspaceProtocolError";
  }
}

export class DesktopWorkspaceUnavailableError extends Error {
  readonly snapshot: DesktopWorkspaceStatus;

  constructor(snapshot: DesktopWorkspaceStatus) {
    super("desktop_workspace_unavailable");
    this.name = "DesktopWorkspaceUnavailableError";
    this.snapshot = snapshot;
  }
}

export class DesktopWorkspaceTransitioningError extends Error {
  readonly snapshot: DesktopWorkspaceStatus;

  constructor(snapshot: DesktopWorkspaceStatus) {
    super("desktop_workspace_transitioning");
    this.name = "DesktopWorkspaceTransitioningError";
    this.snapshot = snapshot;
  }
}

export class DesktopWorkspaceAuthorityConflictError extends Error {
  readonly snapshot: DesktopWorkspaceStatus;

  constructor(snapshot: DesktopWorkspaceStatus) {
    super("desktop_workspace_authority_conflict");
    this.name = "DesktopWorkspaceAuthorityConflictError";
    this.snapshot = snapshot;
  }
}

export class DesktopWorkspaceNativeMutationError extends Error {
  readonly status: number;
  readonly code: string;
  readonly certainty: "notSent" | "possiblySent";

  constructor(error: DesktopWorkspaceNativeErrorWire) {
    super(error.code);
    this.name = "DesktopWorkspaceNativeMutationError";
    this.status = error.status;
    this.code = error.code;
    this.certainty = error.certainty;
  }
}

export class DesktopWorkspaceUnknownOutcomeError extends Error {
  constructor() {
    super("desktop_workspace_mutation_outcome_unknown");
    this.name = "DesktopWorkspaceUnknownOutcomeError";
  }
}

export function createDesktopWorkspaceAuthorityAdapter(
  invoke: DesktopInvoke,
): DesktopWorkspaceAuthorityPort {
  const readStatus = async (): Promise<DesktopWorkspaceStatus> =>
    parseStatus(await invoke("desktop_workspace_status"));

  const prepareMutation = async (
    request: DesktopWorkspaceMutationRequest,
  ): Promise<{
    request: DesktopWorkspaceMutationRequest;
    before: DesktopWorkspaceStatus;
  }> => {
    const parsedRequest = parseMutationRequest(request);
    const before = await readStatus();
    if (before.availability === "unavailable") {
      throw new DesktopWorkspaceUnavailableError(before);
    }
    if (before.availability === "transitioning") {
      throw new DesktopWorkspaceTransitioningError(before);
    }
    if (before.revision !== parsedRequest.expectedRevision) {
      throw new DesktopWorkspaceAuthorityConflictError(before);
    }
    return { request: parsedRequest, before };
  };

  const invokeMutation = async <Result>(
    command: string,
    request: DesktopWorkspaceMutationRequest,
    parseResult: (value: unknown) => Result,
  ): Promise<Result> => {
    let outcomeUnknown = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return parseResult(await invoke(command, { request }));
      } catch (error) {
        /*
         * The retry uses the exact same parsed command and idempotency key. Once
         * the first invocation may have crossed the native admission boundary,
         * only a fully validated terminal response can settle it. A later
         * not-sent/conflict/unavailable response describes the retry attempt,
         * not whether the first attempt committed, so it must never downgrade
         * the original uncertainty.
         */
        if (outcomeUnknown) {
          throw new DesktopWorkspaceUnknownOutcomeError();
        }
        const nativeError = parseNativeError(error);
        if (
          nativeError?.status === 409 &&
          nativeError.code === "desktop_workspace_authority_conflict"
        ) {
          throw new DesktopWorkspaceAuthorityConflictError(await readStatus());
        }
        if (nativeError?.certainty === "notSent") {
          throw new DesktopWorkspaceNativeMutationError(nativeError);
        }
        if (attempt === 0) {
          outcomeUnknown = true;
          continue;
        }
        if (nativeError !== null) {
          throw new DesktopWorkspaceNativeMutationError(nativeError);
        }
        if (error instanceof DesktopWorkspaceProtocolError) throw error;
        throw new DesktopWorkspaceUnknownOutcomeError();
      }
    }
    throw new Error("desktop_workspace_mutation_retry_invariant");
  };

  return {
    status: readStatus,
    async selectAndRegister(request) {
      const prepared = await prepareMutation(request);
      return invokeMutation(
        "desktop_workspace_select_and_register",
        prepared.request,
        (value) => parseSelectResponse(value, prepared.before),
      );
    },
    async clear(request) {
      const prepared = await prepareMutation(request);
      return invokeMutation(
        "desktop_workspace_clear",
        prepared.request,
        (value) => parseClearResponse(value, prepared.before),
      );
    },
  };
}

let desktopAuthority: DesktopWorkspaceAuthorityPort | null = null;

/** Native workspace authority is intentionally absent from Web surfaces. */
export function desktopWorkspaceAuthority(): DesktopWorkspaceAuthorityPort | null {
  if (!hasDesktopBridge()) return null;
  desktopAuthority ??= createDesktopWorkspaceAuthorityAdapter(
    async (command, args) => {
      const bridge = requireDesktopBridge().workspace;
      switch (command) {
        case "desktop_workspace_status":
          return bridge.status();
        case "desktop_workspace_select_and_register":
          return bridge.selectAndRegister(args?.request);
        case "desktop_workspace_clear":
          return bridge.clear(args?.request);
        default:
          throw new Error("desktop_workspace_command_unknown");
      }
    },
  );
  return desktopAuthority;
}

function parseMutationRequest(
  value: DesktopWorkspaceMutationRequest,
): DesktopWorkspaceMutationRequest {
  exactObject(value, ["expectedRevision", "idempotencyKey"]);
  const idempotencyKey = boundedText(
    value.idempotencyKey,
    IDEMPOTENCY_KEY_MAX_BYTES,
    "desktop_workspace_mutation_request_invalid",
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(idempotencyKey)) {
    throw new DesktopWorkspaceProtocolError(
      "desktop_workspace_mutation_request_invalid",
    );
  }
  return {
    expectedRevision: canonicalInteger(value.expectedRevision),
    idempotencyKey,
  };
}

function parseSelectResponse(
  value: unknown,
  before: DesktopWorkspaceStatus,
): DesktopWorkspaceSelectResponse {
  requireWireSize(value, MUTATION_RESPONSE_WIRE_MAX_BYTES);
  exactObject(value, ["outcome", "snapshot"]);
  const snapshot = parseStatus(value.snapshot);
  if (value.outcome === "userCanceled") {
    if (
      snapshot.availability !== "available" ||
      snapshot.revision !== before.revision ||
      snapshot.supervisorGeneration < before.supervisorGeneration ||
      !sameCurrentWorkspace(snapshot.current, before.current)
    ) {
      throw new DesktopWorkspaceProtocolError();
    }
    return { outcome: "userCanceled", snapshot };
  }
  if (value.outcome === "committed") {
    validateCommittedSnapshot(snapshot, before, "selected");
    return { outcome: "committed", snapshot };
  }
  throw new DesktopWorkspaceProtocolError();
}

function sameCurrentWorkspace(
  left: DesktopWorkspaceStatus["current"],
  right: DesktopWorkspaceStatus["current"],
): boolean {
  return (
    (left === null && right === null) ||
    (left !== null && right !== null && left.displayName === right.displayName)
  );
}

function parseClearResponse(
  value: unknown,
  before: DesktopWorkspaceStatus,
): DesktopWorkspaceClearResponse {
  requireWireSize(value, MUTATION_RESPONSE_WIRE_MAX_BYTES);
  exactObject(value, ["outcome", "snapshot"]);
  if (value.outcome !== "committed") {
    throw new DesktopWorkspaceProtocolError();
  }
  const snapshot = parseStatus(value.snapshot);
  validateCommittedSnapshot(snapshot, before, "cleared");
  return { outcome: "committed", snapshot };
}

function validateCommittedSnapshot(
  snapshot: DesktopWorkspaceStatus,
  before: DesktopWorkspaceStatus,
  expected: "cleared" | "selected",
): void {
  if (
    before.revision === Number.MAX_SAFE_INTEGER ||
    snapshot.revision !== before.revision + 1 ||
    snapshot.supervisorGeneration < before.supervisorGeneration ||
    snapshot.availability !== "available" ||
    (expected === "cleared"
      ? snapshot.current !== null
      : snapshot.current === null)
  ) {
    throw new DesktopWorkspaceProtocolError();
  }
}

function parseStatus(value: unknown): DesktopWorkspaceStatus {
  requireWireSize(value, STATUS_WIRE_MAX_BYTES);
  exactObject(value, [
    "schemaVersion",
    "availability",
    "revision",
    "supervisorGeneration",
    "current",
  ]);
  if (value.schemaVersion !== STATUS_SCHEMA_VERSION) {
    throw new DesktopWorkspaceProtocolError();
  }
  const availability = parseAvailability(value.availability);
  const current = parseCurrent(value.current);
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    availability,
    revision: canonicalInteger(value.revision),
    supervisorGeneration: canonicalInteger(value.supervisorGeneration),
    current,
  };
}

function parseCurrent(
  value: unknown,
): Readonly<{ displayName: string }> | null {
  if (value === null) return null;
  exactObject(value, ["displayName"]);
  const displayName = boundedText(
    value.displayName,
    DISPLAY_NAME_MAX_BYTES,
    "desktop_workspace_status_invalid",
  );
  if (
    displayName.includes("/") ||
    displayName.includes("\\") ||
    /^(?:file|https?):/iu.test(displayName)
  ) {
    throw new DesktopWorkspaceProtocolError();
  }
  return { displayName };
}

function parseAvailability(value: unknown): DesktopWorkspaceAvailability {
  if (
    value === "available" ||
    value === "transitioning" ||
    value === "unavailable"
  ) {
    return value;
  }
  throw new DesktopWorkspaceProtocolError();
}

function parseNativeError(
  value: unknown,
): DesktopWorkspaceNativeErrorWire | null {
  try {
    requireWireSize(value, ERROR_WIRE_MAX_BYTES);
    exactObject(value, ["schemaVersion", "status", "code", "certainty"]);
    if (
      value.schemaVersion !== ERROR_SCHEMA_VERSION ||
      (value.certainty !== "notSent" && value.certainty !== "possiblySent")
    ) {
      return null;
    }
    const status = canonicalInteger(value.status);
    if (status < 400 || status > 599) return null;
    const code = boundedText(
      value.code,
      ERROR_CODE_MAX_BYTES,
      "desktop_workspace_error_invalid",
    );
    if (!/^[a-z][a-z0-9_]*$/u.test(code)) return null;
    return {
      schemaVersion: ERROR_SCHEMA_VERSION,
      status,
      code,
      certainty: value.certainty,
    };
  } catch {
    return null;
  }
}

function canonicalInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DesktopWorkspaceProtocolError();
  }
  return value as number;
}

function boundedText(value: unknown, maxBytes: number, code: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maxBytes ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new DesktopWorkspaceProtocolError(code);
  }
  return value;
}

function requireWireSize(value: unknown, maxBytes: number): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new DesktopWorkspaceProtocolError();
  }
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).byteLength > maxBytes
  ) {
    throw new DesktopWorkspaceProtocolError();
  }
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  ) {
    throw new DesktopWorkspaceProtocolError();
  }
}
