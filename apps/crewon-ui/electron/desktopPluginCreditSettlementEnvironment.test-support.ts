import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DESKTOP_PLUGIN_CREDIT_SETTLEMENT_CONFIG_ENV } from "./desktopPluginCreditSettlementEnvironment.ts";

/** Explicit protocol/launch fixture values; no deployed financial service, funds or identity. */
export function desktopFinancialEnvironmentFixture(
  patch: Record<string, unknown> = {},
) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-native-financial-environment-")),
  );
  const path = join(directory, "financial-worker.json");
  const authorizationName = "NAMED_NATIVE_FINANCIAL_AUTHORIZATION_TOKEN";
  const decisionName = "CREWON_FINANCIAL_DECISION_TOKEN";
  const authorizationToken =
    "named-native-financial-authorization-token-at-least-32-bytes";
  const decisionToken =
    "named-native-financial-decision-token-at-least-32-bytes";
  const document = {
    schemaVersion: "crewon.plugin-credit-settlement-worker.v1",
    scope: {
      tenantId: "standalone-tenant",
      spaceId: "standalone-space",
      profileId: "named-native-financial-profile",
    },
    authorityId: "named-native-financial-authority",
    authorityRevision: "named-native-financial-policy-1",
    authorizationAuthority: {
      url: "https://financial.example/authorize",
      serviceTokenEnvironmentVariable: authorizationName,
    },
    decisionAuthority: {
      url: "https://financial.example/decide",
      serviceTokenEnvironmentVariable: decisionName,
    },
    timeoutMs: 1000,
    maxAuthorizationAgeMs: 10_000,
    batchSize: 2,
    intervalMs: 1000,
    maxRoundMs: 5000,
    migrate: false,
    ...patch,
  };
  const write = (value: unknown = document) =>
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  write();
  const environment: NodeJS.ProcessEnv = {
    [DESKTOP_PLUGIN_CREDIT_SETTLEMENT_CONFIG_ENV]: path,
    [authorizationName]: authorizationToken,
    [decisionName]: decisionToken,
    CREWON_MODEL_API_KEY: "named-independent-model-token",
    CREWON_FINANCIAL_UNDECLARED_TOKEN: "unrelated-explicit-environment-value",
    PATH: process.env.PATH,
  };
  return {
    directory,
    path,
    document,
    environment,
    authorizationName,
    decisionName,
    authorizationToken,
    decisionToken,
    write,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
    childAudit(auditPath: string, kind: string): string {
      return `import { appendFileSync as auditAppend } from 'node:fs';
auditAppend(${JSON.stringify(auditPath)}, JSON.stringify({
kind:${JSON.stringify(kind)},
path:process.env.${DESKTOP_PLUGIN_CREDIT_SETTLEMENT_CONFIG_ENV}??null,
authorization:process.env[${JSON.stringify(authorizationName)}]??null,
decision:process.env[${JSON.stringify(decisionName)}]??null,
unrelated:process.env.CREWON_FINANCIAL_UNDECLARED_TOKEN??null,
})+String.fromCharCode(10));\n`;
    },
  };
}
