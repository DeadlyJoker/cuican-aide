import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test(
  "the actual two-minute MCP deadline remains an error even when SIGTERM exits with code zero",
  { skip: process.platform === "win32", timeout: 135_000 },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "crewon-command-deadline-"));
    const executable = join(root, "fixture-command"),
      identityFile = join(root, "identity.json");
    await writeFile(
      executable,
      `#!${process.execPath}\nimport{spawn}from'node:child_process';import{writeFileSync}from'node:fs';
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});
    process.on('SIGTERM',()=>process.exit(0));
    writeFileSync(${JSON.stringify(identityFile)},JSON.stringify({command:process.pid,guard:process.ppid,descendant:child.pid}));setInterval(()=>{},1000);`,
      { mode: 0o700 },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(
          new URL("./local-workspace-checks-mcp.mjs", import.meta.url),
        ),
      ],
      env: {
        PATH: process.env.PATH ?? "",
        CREWON_LOCAL_WORKSPACE_ROOT: root,
        CREWON_LOCAL_PNPM_PATH: executable,
        CREWON_LOCAL_GIT_PATH: executable,
      },
      stderr: "ignore",
    });
    const client = new Client({
      name: "real-command-deadline-fixture",
      version: "1.0.0",
    });
    const signal = new AbortController();
    context.after(async () => {
      signal.abort();
      await client.close();
      await transport.close();
      if (existsSync(identityFile)) {
        const ids = JSON.parse(await readFile(identityFile, "utf8"));
        try {
          process.kill(-ids.guard, "SIGKILL");
        } catch {}
      }
      await rm(root, { recursive: true, force: true });
    });
    await client.connect(transport);
    const started = performance.now();
    const result = await client.callTool(
      { name: "git_status", arguments: {} },
      undefined,
      { signal: signal.signal, timeout: 125_000, maxTotalTimeout: 125_000 },
    );
    const elapsedMs = performance.now() - started;
    assert(
      elapsedMs >= 120_000 && elapsedMs < 125_000,
      `elapsed: ${elapsedMs}`,
    );
    assert.equal(result.isError, true);
    const structured = result.structuredContent as
      | Record<string, unknown>
      | undefined;
    assert.equal(structured?.timedOut, true);
    assert.equal(structured?.exitCode, 0);
    const ids: Record<string, number> = JSON.parse(
      await readFile(identityFile, "utf8"),
    );
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    };
    const deadline = performance.now() + 2000;
    while (Object.values(ids).some(alive) && performance.now() < deadline)
      await delay(20);
    assert(Object.values(ids).every((pid) => !alive(pid)));
  },
);
