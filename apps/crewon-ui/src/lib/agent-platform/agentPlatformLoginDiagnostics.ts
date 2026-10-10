import { AGENT_PLATFORM_AUTH_UNAVAILABLE_MESSAGE } from "./agentPlatformAuthBootstrap";

export const AGENT_PLATFORM_LOGIN_DIAGNOSTIC_EVENT = "crewon-account-login";

type LoginStage = "token_request" | "token_response_body" | "current_user";
type LoginOutcome =
  | "success"
  | "http_rejected"
  | "timeout"
  | "network_error"
  | "cancelled"
  | "invalid_response"
  | "unavailable"
  | "error";

export type AgentPlatformLoginDiagnostic = Readonly<{
  loginAttempt: number;
  stage: LoginStage;
  requestAttempt?: number;
  durationMs: number;
  outcome: LoginOutcome;
  httpStatus?: number;
}>;

type PhaseObserver = Readonly<{
  httpStatus(status: number | undefined): void;
}>;

let nextLoginAttempt = 0;

/** Only fixed phase names, timings and bounded classifications reach the log. */
export function createAgentPlatformLoginDiagnostics() {
  const loginAttempt = ++nextLoginAttempt;
  return Object.freeze({
    async measure<T>(input: {
      stage: LoginStage;
      signal: AbortSignal;
      requestAttempt?: number;
      httpStatus?: number;
      execute(observer: PhaseObserver): Promise<T>;
    }): Promise<T> {
      const startedAt = performance.now();
      let status = input.httpStatus;
      let recorded = false;
      const record = (outcome: LoginOutcome) => {
        if (recorded) return;
        recorded = true;
        const event: AgentPlatformLoginDiagnostic = Object.freeze({
          loginAttempt,
          stage: input.stage,
          ...(input.requestAttempt === undefined
            ? {}
            : { requestAttempt: input.requestAttempt }),
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          outcome,
          ...(typeof status === "number" &&
          Number.isInteger(status) &&
          status >= 100 &&
          status <= 599
            ? { httpStatus: status }
            : {}),
        });
        try {
          console.info(AGENT_PLATFORM_LOGIN_DIAGNOSTIC_EVENT, event);
        } catch {
          // Diagnostics cannot change account verification or transport results.
        }
      };
      const abort = () => record(errorOutcome(input.signal.reason));
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      try {
        const result = await input.execute({
          httpStatus(next) {
            status = next;
          },
        });
        record(
          status !== undefined && status >= 400 ? "http_rejected" : "success",
        );
        return result;
      } catch (error) {
        record(
          status !== undefined && status >= 400
            ? "http_rejected"
            : errorOutcome(error),
        );
        throw error;
      } finally {
        input.signal.removeEventListener("abort", abort);
      }
    },
  });
}

function errorOutcome(error: unknown): LoginOutcome {
  if (!(error instanceof Error)) return "error";
  if (error.name === "TimeoutError") return "timeout";
  if (
    error.name === "AbortError" ||
    error.message === "agent_platform_session_changed"
  )
    return "cancelled";
  if (error instanceof SyntaxError) return "invalid_response";
  if (
    error instanceof TypeError ||
    error.message === "desktop_http_transport_failed"
  )
    return "network_error";
  if (error.message === "desktop_http_response_timeout") return "timeout";
  if (error.message === AGENT_PLATFORM_AUTH_UNAVAILABLE_MESSAGE)
    return "unavailable";
  return "error";
}

export type AgentPlatformLoginDiagnostics = ReturnType<
  typeof createAgentPlatformLoginDiagnostics
>;
