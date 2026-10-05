import type { ActiveProvider } from "./providerCredentials.ts";

const PROBE_FIELDS = [
  "CREWON_PROVIDER_PROBE_CREDENTIAL_ENVIRONMENT",
  "CREWON_PROVIDER_PROBE_ENDPOINT",
  "CREWON_PROVIDER_PROBE_PORT",
  "CREWON_PROVIDER_PROBE_PROVIDER_ID",
  "CREWON_PROVIDER_PROBE_RUNTIME_BINDING_ID",
  "CREWON_PROVIDER_PROBE_TOKEN",
  "CREWON_PROVIDER_PROBE_WORKER_ORIGIN",
  "CREWON_PROVIDER_PROBE_WORKER_TOKEN",
] as const;

/** Private probe declarations require the real active credential; discovery never invents one. */
export function withDesktopProviderProbeEnvironment(
  input: Readonly<{
    environment: NodeJS.ProcessEnv;
    provider: ActiveProvider;
    port: number;
    token: string;
    runtimeBindingId: string;
  }>,
): NodeJS.ProcessEnv {
  const environment = { ...input.environment };
  for (const name of PROBE_FIELDS) delete environment[name];
  if (input.provider.apiKey === null) {
    // An isolated optional timeout also declares a Control probe; retain no partial declaration.
    delete environment.CREWON_PROVIDER_PROBE_WORKER_TIMEOUT_MS;
    return environment;
  }
  return {
    ...environment,
    CREWON_PROVIDER_PROBE_CREDENTIAL_ENVIRONMENT: "CREWON_MODEL_API_KEY",
    CREWON_PROVIDER_PROBE_ENDPOINT: input.provider.endpoint,
    CREWON_PROVIDER_PROBE_PORT: String(input.port),
    CREWON_PROVIDER_PROBE_PROVIDER_ID: input.provider.providerId,
    CREWON_PROVIDER_PROBE_RUNTIME_BINDING_ID: input.runtimeBindingId,
    CREWON_PROVIDER_PROBE_TOKEN: input.token,
    CREWON_PROVIDER_PROBE_WORKER_ORIGIN: `http://127.0.0.1:${input.port}`,
    CREWON_PROVIDER_PROBE_WORKER_TOKEN: input.token,
  };
}
