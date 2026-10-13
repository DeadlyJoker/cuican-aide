import { Pool } from "pg";
import {
  PostgresPimActorBindings,
  PostgresWebPluginProfileStore,
} from "@crewon/store";
import {
  HttpIdentitySessionAdapter,
  type WebIdentitySessionPort,
} from "./identity-session-adapter.ts";
import { PimAccountAuthority } from "./pim-account-authority.ts";
import { PimControlSessions } from "./pim-control-sessions.ts";
import { createPimAuthorityHttp } from "./pim-authority-http.ts";
import { readWebPluginPackageApprovals } from "./web-plugin-package-approvals.ts";

export type WebIdentityRuntime = Readonly<{
  identity: WebIdentitySessionPort;
  accountExchange?: PimControlSessions;
  authority?: ReturnType<typeof createPimAuthorityHttp>;
  close(): Promise<void>;
}>;
/** Explicit directory adapter selection. Startup validates existing authority
 * schemas and never creates, adopts or rewrites an account or historical realm.
 */
export async function createWebIdentityRuntime(
  environment: NodeJS.ProcessEnv,
): Promise<WebIdentityRuntime> {
  const mode = environment.CREWON_WEB_IDENTITY_MODE ?? "identity-center";
  if (mode === "identity-center") {
    return {
      identity: new HttpIdentitySessionAdapter({
        endpoint: required(environment, "CREWON_IDENTITY_SESSION_URL"),
        serviceToken: required(environment, "CREWON_IDENTITY_SERVICE_TOKEN"),
        timeoutMs: timeout(environment.CREWON_IDENTITY_TIMEOUT_MS ?? "5000"),
      }),
      close: async () => {},
    };
  }
  if (mode !== "pim") throw new Error("web_identity_mode_invalid");
  const approval = readWebPluginPackageApprovals(
    required(environment, "CREWON_WEB_PIM_APPROVED_PACKAGES_JSON"),
  );
  const pool = new Pool({
    connectionString: required(environment, "CREWON_WEB_PROFILE_DATABASE_URL"),
    max: 4,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    application_name: "crewon-web-identity",
  });
  let sessions: PimControlSessions | undefined;
  try {
    const profiles = new PostgresWebPluginProfileStore({
      pool,
      schema: required(environment, "CREWON_WEB_PROFILE_DATABASE_SCHEMA"),
    });
    const bindings = new PostgresPimActorBindings({
      pool,
      schema: required(environment, "CREWON_WEB_BINDINGS_DATABASE_SCHEMA"),
    });
    await profiles.assertReady();
    await bindings.assertReady();
    sessions = new PimControlSessions({
      accounts: new PimAccountAuthority({
        origin: required(environment, "CREWON_WEB_PIM_ORIGIN"),
        permissionOrigin: required(environment, "CREWON_WEB_PERMISSION_ORIGIN"),
        cacheTtlMs: directoryCacheTtl(
          environment.CREWON_WEB_PIM_CACHE_TTL_MS ?? "0",
        ),
      }),
      profiles,
      actorBindings: bindings,
      issuer: required(environment, "CREWON_IDENTITY_EXPECTED_ISSUER"),
      packages: approval,
    });
    const current = sessions;
    return {
      identity: current,
      accountExchange: current,
      authority: createPimAuthorityHttp({
        sessions: current,
        identityServiceToken: required(
          environment,
          "CREWON_IDENTITY_SERVICE_TOKEN",
        ),
        policyServiceToken: required(
          environment,
          "CREWON_POLICY_SERVICE_TOKEN",
        ),
      }),
      close: async () => {
        current.close();
        await pool.end();
      },
    };
  } catch (error) {
    sessions?.close();
    await pool.end();
    throw error;
  }
}
function directoryCacheTtl(value: string): number {
  if (!/^(0|[1-9][0-9]{0,2})$/u.test(value) || Number(value) > 250)
    throw new Error("CREWON_WEB_PIM_CACHE_TTL_MS_invalid");
  return Number(value);
}
function timeout(value: string): number {
  if (!/^[1-9][0-9]{0,4}$/u.test(value) || Number(value) > 30000)
    throw new Error("CREWON_IDENTITY_TIMEOUT_MS_invalid");
  return Number(value);
}
function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value?.trim()) throw new Error(`${name}_required`);
  return value;
}
