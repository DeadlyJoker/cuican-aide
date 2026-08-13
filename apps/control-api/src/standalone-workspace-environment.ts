type Environment = Readonly<Record<string, string | undefined>>;

export type StandaloneWorkspaceWorkerEnvironment = Readonly<{
  origin: string;
  token: string;
  workspaceBindingId: string;
  deadlineMs?: number;
}>;

const ORIGIN = "CREWON_WORKSPACE_WORKER_ORIGIN";
const TOKEN = "CREWON_WORKSPACE_WORKER_TOKEN";
const DEADLINE = "CREWON_WORKSPACE_WORKER_DEADLINE_MS";
const BINDING = "CREWON_WORKSPACE_BINDING_ID";
const NAMES = [ORIGIN, TOKEN, DEADLINE, BINDING] as const;

/**
 * Projects the PC-only Worker route. Production rejects these ambient values
 * so a Team process can never acquire a plaintext local bearer token.
 */
export function resolveStandaloneWorkspaceWorkerEnvironment(
  environment: Environment,
  securityMode: "standalone" | "production",
): StandaloneWorkspaceWorkerEnvironment | undefined {
  const declared = NAMES.some((name) => environment[name] !== undefined);
  if (securityMode === "production") {
    if (declared) {
      throw new Error("CREWON_WORKSPACE_WORKER_CONFIGURATION_forbidden");
    }
    return undefined;
  }
  if (!declared) return undefined;

  const origin = requiredExact(environment, ORIGIN);
  const token = requiredExact(environment, TOKEN);
  const workspaceBindingId = requiredExact(environment, BINDING);
  if (
    workspaceBindingId.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(workspaceBindingId)
  )
    throw new Error("CREWON_WORKSPACE_BINDING_ID_invalid");
  const deadline = environment[DEADLINE];
  const parsedOrigin = loopbackOrigin(origin);
  const bytes = Buffer.byteLength(token, "utf8");
  if (bytes < 32 || bytes > 8_192 || /[\u0000-\u001f\u007f]/u.test(token)) {
    throw new Error("CREWON_WORKSPACE_WORKER_TOKEN_invalid");
  }
  if (deadline === undefined)
    return { origin: parsedOrigin, token, workspaceBindingId };
  if (deadline !== deadline.trim() || !/^\d{4,5}$/u.test(deadline)) {
    throw new Error("CREWON_WORKSPACE_WORKER_DEADLINE_MS_invalid");
  }
  const deadlineMs = Number(deadline);
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1_000 ||
    deadlineMs > 60_000
  ) {
    throw new Error("CREWON_WORKSPACE_WORKER_DEADLINE_MS_invalid");
  }
  return { origin: parsedOrigin, token, workspaceBindingId, deadlineMs };
}

function requiredExact(environment: Environment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error("CREWON_WORKSPACE_WORKER_CONFIGURATION_incomplete");
  }
  if (value !== value.trim()) {
    throw new Error(`${name}_invalid`);
  }
  return value;
}

function loopbackOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CREWON_WORKSPACE_WORKER_ORIGIN_invalid");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.port === "" ||
    url.origin !== value
  ) {
    throw new Error("CREWON_WORKSPACE_WORKER_ORIGIN_invalid");
  }
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CREWON_WORKSPACE_WORKER_ORIGIN_invalid");
  }
  return url.origin;
}
