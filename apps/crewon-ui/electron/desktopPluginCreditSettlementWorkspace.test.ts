import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as documentCapture from "./desktopInstalledPluginRuntimeConfiguration.ts";
import { DESKTOP_PLUGIN_CREDIT_SETTLEMENT_CONFIG_ENV } from "./desktopPluginCreditSettlementEnvironment.ts";
import { desktopFinancialEnvironmentFixture } from "./desktopPluginCreditSettlementEnvironment.test-support.ts";
import { withWorkspaceProcesses } from "./localWorkspaceProcesses.ts";

type Fixture = ReturnType<typeof desktopFinancialEnvironmentFixture>;
const authorizationName = "WORKSPACE_PRIVATE_AUTHORITY_REF";
const decisionName = "INDEPENDENT_SETTLEMENT_BEARER_REF";

function financialFixture() {
  const f = desktopFinancialEnvironmentFixture();
  const document = {
    ...f.document,
    authorizationAuthority: {
      ...f.document.authorizationAuthority,
      serviceTokenEnvironmentVariable: authorizationName,
    },
    decisionAuthority: {
      ...f.document.decisionAuthority,
      serviceTokenEnvironmentVariable: decisionName,
    },
  };
  f.write(document);
  const environment: NodeJS.ProcessEnv = {
    ...f.environment,
    [authorizationName]: f.authorizationToken,
    [decisionName]: f.decisionToken,
    WORKSPACE_ORDINARY_VALUE: "named-ordinary-value",
  };
  delete environment[f.authorizationName];
  delete environment[f.decisionName];
  return {
    ...f,
    document,
    environment,
    write: (value: unknown = document) => f.write(value),
  };
}

function stubAmbient(environment: NodeJS.ProcessEnv) {
  for (const [name, value] of Object.entries(environment))
    vi.stubEnv(name, value);
}

function childRequest(
  f: Fixture,
  environment?: NodeJS.ProcessEnv,
  marker?: string,
) {
  // The actual child reports only presence flags and a named unrelated value.
  // It never writes credential values or makes a financial/provider request.
  const code = `
import { writeFileSync } from 'node:fs';
const refs = ${JSON.stringify([
    DESKTOP_PLUGIN_CREDIT_SETTLEMENT_CONFIG_ENV,
    authorizationName,
    decisionName,
  ])};
const marker = ${JSON.stringify(marker ?? null)};
if (marker !== null) writeFileSync(marker, 'spawned');
process.stdout.write(JSON.stringify({
  financialRefsAbsent: refs.every(name => !Object.hasOwn(process.env, name)),
  ordinary: process.env.WORKSPACE_ORDINARY_VALUE ?? null,
  undeclaredPresent: Object.hasOwn(process.env, 'CREWON_FINANCIAL_UNDECLARED_TOKEN'),
}));
`;
  return {
    command: process.execPath,
    args: ["--input-type=module", "--eval", code],
    cwd: f.directory,
    timeoutMs: 5000,
    maximumOutputBytes: 1024,
    ...(environment === undefined ? {} : { environment }),
  };
}

beforeEach(() => {
  vi.stubEnv(DESKTOP_PLUGIN_CREDIT_SETTLEMENT_CONFIG_ENV, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Native workspace subprocess financial environment", () => {
  it("removes declared arbitrary credential aliases from an actual ambient child", async () => {
    const f = financialFixture();
    stubAmbient(f.environment);
    try {
      const result = await withWorkspaceProcesses((run) =>
        run(childRequest(f)),
      );
      expect(result).toMatchObject({
        exitCode: 0,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
      });
      expect(JSON.parse(result.stdout)).toEqual({
        financialRefsAbsent: true,
        ordinary: "named-ordinary-value",
        undeclaredPresent: true,
      });
    } finally {
      f.cleanup();
    }
  });

  it.each(["declared-overlay", "custom-only"] as const)(
    "projects the final %s request environment against the original ambient file",
    async (kind) => {
      const f = financialFixture();
      stubAmbient(f.environment);
      const environment: NodeJS.ProcessEnv =
        kind === "declared-overlay"
          ? { ...f.environment, WORKSPACE_ORDINARY_VALUE: "named-custom-value" }
          : { WORKSPACE_ORDINARY_VALUE: "named-custom-value" };
      const original = { ...environment };
      try {
        const result = await withWorkspaceProcesses((run) =>
          run(childRequest(f, environment)),
        );
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toEqual({
          financialRefsAbsent: true,
          ordinary: "named-custom-value",
          undeclaredPresent: kind === "declared-overlay",
        });
        expect(environment).toEqual(original);
      } finally {
        f.cleanup();
      }
    },
  );

  it("preserves ordinary explicit environment without financial opt-in or file capture", async () => {
    const f = desktopFinancialEnvironmentFixture();
    const capture = vi.spyOn(
      documentCapture,
      "captureDesktopInstalledPluginRuntimeDocument",
    );
    const environment = {
      WORKSPACE_ORDINARY_VALUE: "named-unconfigured-value",
      CREWON_FINANCIAL_UNDECLARED_TOKEN: "named-unbound-ordinary-value",
    };
    try {
      const result = await withWorkspaceProcesses((run) =>
        run(childRequest(f, environment)),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        financialRefsAbsent: true,
        ordinary: "named-unconfigured-value",
        undeclaredPresent: true,
      });
      expect(capture).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });

  it.each([
    "malformed-file",
    "non-private-file",
    "conflicting-overlay",
  ] as const)(
    "rejects %s before actual spawn and releases all four operation slots",
    async (kind) => {
      const f = financialFixture();
      stubAmbient(f.environment);
      const marker = join(f.directory, "unexpected-child-started");
      if (kind === "malformed-file") writeFileSync(f.path, "{invalid-json");
      if (kind === "non-private-file") chmodSync(f.path, 0o644);
      const environment =
        kind === "conflicting-overlay"
          ? {
              ...f.environment,
              [authorizationName]: "named-conflicting-final-overlay-value",
            }
          : undefined;
      try {
        const results = await Promise.allSettled(
          Array.from({ length: 4 }, () =>
            withWorkspaceProcesses((run) =>
              run(childRequest(f, environment, marker)),
            ),
          ),
        );
        for (const result of results) {
          expect(result.status).toBe("rejected");
          if (result.status === "rejected")
            expect(result.reason).toHaveProperty(
              "message",
              kind === "conflicting-overlay"
                ? "desktop_plugin_credit_settlement_environment_overlay_conflict"
                : "desktop_plugin_credit_settlement_environment_invalid",
            );
        }
        expect(existsSync(marker)).toBe(false);
        f.write();
        chmodSync(f.path, 0o600);
        // A leaked failed-start lease would exhaust the original four slots here.
        const resumed = await withWorkspaceProcesses((run) =>
          run(childRequest(f)),
        );
        expect(resumed.exitCode).toBe(0);
        expect(resumed.stderr).toBe("");
        expect(JSON.parse(resumed.stdout).financialRefsAbsent).toBe(true);
      } finally {
        f.cleanup();
      }
    },
  );
});
