import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { DeterministicFakeModelTransport } from "@crewon/agent-kernel";
import { readOnlyPolicy } from "../../../packages/mcp-runtime/src/mcp-tool-runtime.test-support.ts";
import { activateStandaloneRuntimeAgentVersionRelease } from "./agent-version-release-composition.ts";
import { createConfiguredToolRuntime } from "./runtime-process-environment.ts";

export function bootstrapProcessFixture(
  t: TestContext,
  options: { closeDelayMs?: number; holdCloseUntilReleased?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "crewon-bootstrap-process-"));
  const pidFile = join(root, "mcp.pid"),
    closingFile = join(root, "mcp.closing"),
    configPath = join(root, "mcp.json"),
    databasePath = join(root, "control.sqlite"),
    releaseFile = join(root, "mcp.release");
  const releaseClose = () =>
    writeFileSync(releaseFile, "release", { mode: 0o600 });
  if (options.holdCloseUntilReleased) releaseClose();
  writeFileSync(
    configPath,
    JSON.stringify({
      schemaVersion: "crewon.mcp-stdio-config.v0",
      servers: [
        {
          serverId: "fixture",
          command: process.execPath,
          args: [
            "--experimental-strip-types",
            fileURLToPath(
              new URL(
                "./runtime-bootstrap-mcp.test-support.ts",
                import.meta.url,
              ),
            ),
            pidFile,
            closingFile,
            String(options.closeDelayMs ?? 0),
            ...(options.holdCloseUntilReleased ? [releaseFile] : []),
          ],
          cwd: root,
          env: {},
          tools: { echo: readOnlyPolicy() },
        },
      ],
    }),
  );
  const environment = {
    PATH: dirname(process.execPath),
    CREWON_MODEL_ADAPTER: "deterministic-fake",
    CREWON_FAKE_EXPECTED_USER_MESSAGE: "fixture",
    CREWON_FAKE_RESPONSE: "fixture",
    CREWON_MCP_STDIO_CONFIG_PATH: configPath,
    CREWON_CONTROL_DB_PATH: databasePath,
    CREWON_WORKER_ONCE: "1",
  };
  const pid = () => {
    const value = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(value) && value > 1);
    return value;
  };
  const gone = () => {
    try {
      process.kill(pid(), 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
  };
  t.after(async () => {
    if (existsSync(pidFile) && !gone()) {
      process.kill(pid(), "SIGKILL");
      await waitFor(gone);
    }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    environment,
    gone,
    pid,
    closingFile,
    releaseClose,
    activate: async () => {
      const toolRuntime = await createConfiguredToolRuntime(environment);
      try {
        await activateStandaloneRuntimeAgentVersionRelease({
          databasePath,
          runtimeTenantId: "standalone-tenant",
          route: {
            authorityId: "standalone-authority",
            runtimeGeneration: "ts-v0",
            agentVersionId: "default-agent-v1",
            policySnapshotId: "standalone-policy-v0",
            workspaceBindingId: null,
          },
          transport: new DeterministicFakeModelTransport({
            expectedLastUserMessage: "fixture",
            events: [],
          }),
          toolRuntime,
          streamMaxRetries: 5,
          autoCompactAtTokens: 200000,
          modelContextWindowTokens: 273000,
          actor: {
            principalId: "fixture",
            actorId: "fixture",
            tenantId: "standalone-tenant",
            spaceId: "fixture",
          },
          authorization: { authorize: async () => ({ outcome: "allow" }) },
          clock: { now: () => "2026-09-15T00:00:00Z" },
          activationId: "fixture",
        });
      } finally {
        await toolRuntime?.close?.();
      }
      rmSync(closingFile, { force: true });
      if (options.holdCloseUntilReleased) rmSync(releaseFile, { force: true });
    },
    start: (
      changes: Record<string, string | undefined> = {},
      options: { modelCloseFailure?: boolean } = {},
    ) => {
      const child = spawn(
        process.execPath,
        [
          ...(options.modelCloseFailure
            ? [
                "--import",
                new URL(
                  "./runtime-bootstrap-close-error.test-support.ts",
                  import.meta.url,
                ).href,
              ]
            : []),
          "--experimental-strip-types",
          fileURLToPath(new URL("./main.ts", import.meta.url)),
        ],
        {
          cwd: root,
          env: { ...environment, ...changes },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.length > 65536) child.kill("SIGKILL");
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 65536) child.kill("SIGKILL");
      });
      const completion = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        mcpGoneAtWorkerExit: boolean;
        exitedAt: number;
      }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) =>
          resolve({
            code,
            signal,
            mcpGoneAtWorkerExit: existsSync(pidFile) && gone(),
            exitedAt: Date.now(),
          }),
        );
      });
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await completion;
      });
      return { child, completion, stdout: () => stdout, stderr: () => stderr };
    },
  };
}

export async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "bootstrap process condition timed out");
    await delay(10);
  }
}
