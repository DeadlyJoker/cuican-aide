import { AsyncLocalStorage } from "node:async_hooks";

const GENERATION_ACTION = "crewon.project-generations.v1.generateConcept";
const MAX_REQUEST_RECORDS = 96;
const MAX_ACTIVE_SCOPES = 32;
const PREFIX = "CREWON_PLUGIN_INVOCATION_DIAGNOSTIC:";
const now = performance.now.bind(performance);
const phases = [
  "route.invoke",
  "generation.current",
  "generation.target-package",
  "generation.source-bytes",
  "generation.target-bytes",
  "generation.target-policy",
  "generation.transaction-identity",
  "generation.transaction-profile",
  "generation.transaction-policy",
  "generation.transaction-bytes",
  "generation.transaction-access",
  "generation.saved-prompt",
  "generation.node-prepare",
  "generation.node-current",
  "generation.node-execute",
  "generation.task-commit",
  "generation.node-close",
] as const;
export type PluginGenerationDiagnosticPhase = (typeof phases)[number];
const allowedPhases = new Set<string>(phases);
type Scope = {
  requestId: string;
  started: number;
  sequence: number;
  alive: boolean;
};
type Sink = (line: string) => boolean | void;
export type PluginInvocationDiagnostics = Readonly<{
  runPluginGenerationDiagnostics<T>(
    requestId: string,
    action: string,
    work: () => Promise<T>,
  ): Promise<T>;
  observePluginGenerationPhase<T>(
    phase: PluginGenerationDiagnosticPhase,
    work: () => Promise<T>,
  ): Promise<T>;
}>;

/** Separate factories use the same implementation without sharing test/production scopes.
 * A false sink result means backpressure: silence is latched, never queued or awaited.
 * Sink exceptions likewise disable diagnostics, while the original business work proceeds. */
export function createPluginInvocationDiagnostics(
  input: Readonly<{ enabled: boolean; sink?: Sink }>,
): PluginInvocationDiagnostics {
  const storage = new AsyncLocalStorage<Scope | undefined>();
  let enabled = false;
  let sink: Sink = (line) => process.stderr.write(line + "\n");
  try {
    // Configuration getters/proxies must not become business dependencies.
    const enabledField = Object.getOwnPropertyDescriptor(input, "enabled");
    const sinkField = Object.getOwnPropertyDescriptor(input, "sink");
    enabled = enabledField?.value === true;
    if (sinkField !== undefined) {
      if (typeof sinkField.value === "function") sink = sinkField.value;
      else enabled = false;
    }
  } catch {
    enabled = false;
  }
  let activeScopes = 0;
  let silenced = false;

  const emit = (
    scope: Scope,
    phase: PluginGenerationDiagnosticPhase,
    status: "start" | "end" | "error",
  ): void => {
    if (!scope.alive || silenced || scope.sequence >= MAX_REQUEST_RECORDS)
      return;
    try {
      // Only captured server identity and fixed primitives enter serialization.
      const line =
        PREFIX +
        JSON.stringify({
          requestId: scope.requestId,
          pid: process.pid,
          elapsedMs:
            Math.round(Math.max(0, now() - scope.started) * 1000) / 1000,
          sequence: ++scope.sequence,
          phase,
          status,
        });
      if (sink(line) === false) silenced = true;
    } catch {
      silenced = true;
    }
  };

  const observePluginGenerationPhase = async <T>(
    phase: PluginGenerationDiagnosticPhase,
    work: () => Promise<T>,
  ): Promise<T> => {
    if (!enabled || silenced) return work();
    const scope = storage.getStore();
    if (scope === undefined || !scope.alive || !allowedPhases.has(phase))
      return work();
    emit(scope, phase, "start");
    try {
      const result = await work();
      emit(scope, phase, "end");
      return result;
    } catch (error) {
      // Do not inspect a result, thrown value, message, stack or error code.
      emit(scope, phase, "error");
      throw error;
    }
  };

  const runPluginGenerationDiagnostics = async <T>(
    requestId: string,
    action: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    if (!enabled) return work();
    if (
      silenced ||
      action !== GENERATION_ACTION ||
      typeof requestId !== "string" ||
      requestId.length > 52 ||
      !/^req-[a-zA-Z0-9]{1,48}$/u.test(requestId) ||
      activeScopes >= MAX_ACTIVE_SCOPES
    )
      // Nested excluded actions cannot borrow an outer generation's diagnostic identity.
      return storage.getStore() === undefined
        ? work()
        : storage.run(undefined, work);
    const scope: Scope = {
      requestId,
      started: now(),
      sequence: 0,
      alive: true,
    };
    activeScopes++;
    return storage.run(scope, async () => {
      try {
        return await observePluginGenerationPhase("route.invoke", work);
      } finally {
        scope.alive = false;
        activeScopes--;
      }
    });
  };
  return Object.freeze({
    runPluginGenerationDiagnostics,
    observePluginGenerationPhase,
  });
}

function diagnosticsEnabled(): boolean {
  try {
    return process.env.CREWON_PLUGIN_INVOCATION_DIAGNOSTICS === "1";
  } catch {
    return false;
  }
}
const production = createPluginInvocationDiagnostics({
  enabled: diagnosticsEnabled(),
});
export const runPluginGenerationDiagnostics =
  production.runPluginGenerationDiagnostics;
export const observePluginGenerationPhase =
  production.observePluginGenerationPhase;
