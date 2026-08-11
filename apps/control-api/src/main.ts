import {
  FilesystemArtifactStore,
  loadArtifactEncryptionKey,
} from "@crewon/artifacts";

import { createProductionPostgresControlApi } from "./production-composition.ts";
import {
  HttpControlTokenVerifier,
  HttpPolicyDecisionPort,
} from "./production-http-security-ports.ts";
import {
  DynamicPolicyAuthorization,
  ProductionControlApiIdentity,
  StaticTrustedBffRequestVerifier,
} from "./production-security-adapters.ts";
import {
  createPostgresControlApi,
  createStandaloneControlApi,
} from "./standalone-composition.ts";

const securityMode = parseSecurityMode(
  process.env.CREWON_CONTROL_SECURITY_MODE ?? "standalone",
);
const connectionString = process.env.CREWON_CONTROL_DATABASE_URL?.trim();
if (securityMode === "production" && connectionString === undefined) {
  throw new Error("CREWON_CONTROL_DATABASE_URL_required");
}
const artifactEncryptionKeyId = requiredEnvironment(
  "CREWON_ARTIFACT_ENCRYPTION_KEY_ID",
);
const artifactStore = new FilesystemArtifactStore({
  rootDirectory: requiredEnvironment("CREWON_ARTIFACT_ROOT"),
  databasePath: requiredEnvironment("CREWON_ARTIFACT_DB_PATH"),
  encryptionKey: loadArtifactEncryptionKey(
    requiredEnvironment("CREWON_ARTIFACT_ENCRYPTION_KEY_PATH"),
  ),
  keyId: artifactEncryptionKeyId,
});
const sharedConfig = {
  artifactStore,
  artifactEncryptionKeyId,
  outboxScanIntervalMs: parsePositiveInteger(
    process.env.CREWON_OUTBOX_SCAN_INTERVAL_MS ?? "1000",
    "CREWON_OUTBOX_SCAN_INTERVAL_MS_invalid",
  ),
};
let runtime;
try {
  if (securityMode === "production") {
    const productionConnectionString = requiredEnvironment(
      "CREWON_CONTROL_DATABASE_URL",
    );
    const authorityTimeoutMs = parsePositiveInteger(
      process.env.CREWON_SECURITY_AUTHORITY_TIMEOUT_MS ?? "2000",
      "CREWON_SECURITY_AUTHORITY_TIMEOUT_MS_invalid",
    );
    const identity = new ProductionControlApiIdentity({
      trustedBff: new StaticTrustedBffRequestVerifier({
        serviceToken: requiredEnvironment("CREWON_CONTROL_BFF_TOKEN"),
        allowedOrigins: splitRequiredEnvironment("CREWON_BFF_ALLOWED_ORIGINS"),
        allowedRemoteAddresses: splitRequiredEnvironment(
          "CREWON_BFF_ALLOWED_REMOTE_ADDRESSES",
        ),
      }),
      tokens: new HttpControlTokenVerifier({
        url: requiredEnvironment("CREWON_IDENTITY_VERIFY_URL"),
        serviceToken: requiredEnvironment("CREWON_IDENTITY_SERVICE_TOKEN"),
      }),
      expectedIssuer: requiredEnvironment("CREWON_IDENTITY_EXPECTED_ISSUER"),
      expectedAudience: requiredEnvironment(
        "CREWON_IDENTITY_EXPECTED_AUDIENCE",
      ),
      timeoutMs: authorityTimeoutMs,
      cacheTtlMs: parseNonNegativeInteger(
        process.env.CREWON_IDENTITY_CACHE_TTL_MS ?? "0",
        "CREWON_IDENTITY_CACHE_TTL_MS_invalid",
      ),
      cacheMaxEntries: parsePositiveInteger(
        process.env.CREWON_IDENTITY_CACHE_MAX_ENTRIES ?? "1000",
        "CREWON_IDENTITY_CACHE_MAX_ENTRIES_invalid",
      ),
    });
    const authorization = new DynamicPolicyAuthorization({
      policy: new HttpPolicyDecisionPort({
        url: requiredEnvironment("CREWON_POLICY_DECISION_URL"),
        serviceToken: requiredEnvironment("CREWON_POLICY_SERVICE_TOKEN"),
      }),
      timeoutMs: authorityTimeoutMs,
    });
    runtime = await createProductionPostgresControlApi({
      ...sharedConfig,
      connectionString: productionConnectionString,
      identity,
      authorization,
      ...(process.env.CREWON_CONTROL_DATABASE_SCHEMA?.trim()
        ? { schema: process.env.CREWON_CONTROL_DATABASE_SCHEMA.trim() }
        : {}),
    });
  } else {
    const standaloneConfig = {
      ...sharedConfig,
      actor: {
        principalId: environmentOr(
          "CREWON_PRINCIPAL_ID",
          "standalone-principal",
        ),
        actorId: environmentOr("CREWON_ACTOR_ID", "standalone-actor"),
        tenantId: environmentOr("CREWON_TENANT_ID", "standalone-tenant"),
        spaceId: environmentOr("CREWON_SPACE_ID", "standalone-space"),
      },
      defaultAgentVersionId: environmentOr(
        "CREWON_AGENT_VERSION_ID",
        "default-agent-v1",
      ),
      sessionToken: requiredEnvironment("CREWON_CONTROL_SESSION_TOKEN"),
      csrfToken: requiredEnvironment("CREWON_CONTROL_CSRF_TOKEN"),
      allowedOrigins: splitRequiredEnvironment(
        "CREWON_CONTROL_ALLOWED_ORIGINS",
      ),
    };
    runtime = connectionString
      ? await createPostgresControlApi({
          ...standaloneConfig,
          connectionString,
          ...(process.env.CREWON_CONTROL_DATABASE_SCHEMA?.trim()
            ? { schema: process.env.CREWON_CONTROL_DATABASE_SCHEMA.trim() }
            : {}),
        })
      : createStandaloneControlApi({
          ...standaloneConfig,
          databasePath: requiredEnvironment("CREWON_CONTROL_DB_PATH"),
        });
  }
} catch (error) {
  await artifactStore.close();
  throw error;
}

const port = parsePort(process.env.CREWON_CONTROL_PORT ?? "3210");
await runtime.app.listen({ host: "127.0.0.1", port });
process.stdout.write(`CrewON Control API listening on 127.0.0.1:${port}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void runtime.app.close().finally(() => process.exit(0));
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name}_required`);
  }
  return value;
}

function environmentOr(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function splitRequiredEnvironment(name: string): string[] {
  const values = requiredEnvironment(name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error(`${name}_required`);
  }
  return values;
}

function parseSecurityMode(value: string): "standalone" | "production" {
  if (value === "standalone" || value === "production") {
    return value;
  }
  throw new Error("CREWON_CONTROL_SECURITY_MODE_invalid");
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CREWON_CONTROL_PORT_invalid");
  }
  return port;
}

function parsePositiveInteger(value: string, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(code);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(code);
  }
  return parsed;
}
