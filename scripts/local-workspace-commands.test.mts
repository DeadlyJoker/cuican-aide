import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { getEventListeners } from "node:events";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createWorkspaceCommands } from "./local-workspace-commands.mts";

const entry = fileURLToPath(
  new URL("./local-workspace-checks-mcp.mjs", import.meta.url),
);
type Identity = { command: number; guard: number; descendant: number };
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};
async function until(check: () => boolean, label: string) {
  const deadline = performance.now() + 5000;
  while (!check()) {
    assert(performance.now() < deadline, label);
    await delay(20);
  }
}
async function identity(root: string): Promise<Identity> {
  const path = join(root, "identity.json");
  await until(() => existsSync(path), "command identity was not written");
  return JSON.parse(await readFile(path, "utf8"));
}
async function gone(ids: Identity) {
  await until(
    () => Object.values(ids).every((pid) => !alive(pid)),
    "owned processes remained alive",
  );
}

async function fixture(context: TestContext, parentExits = false) {
  const root = await mkdtemp(join(tmpdir(), "crewon-workspace-command-"));
  const file = join(root, "fixture.mjs"),
    executable = join(root, "fixture-command");
  const source = `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
    process.on('SIGTERM',()=>{});
    const descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});
    writeFileSync(${JSON.stringify(join(root, "identity.json"))},JSON.stringify({command:process.pid,guard:process.ppid,descendant:descendant.pid}));
    ${parentExits ? "setTimeout(()=>process.exit(0),100);" : "setInterval(()=>{},1000);"}`;
  await writeFile(file, source);
  // The executable is only used by the actual POSIX MCP integration fixtures.
  await writeFile(executable, `#!${process.execPath}\n${source}`, {
    mode: 0o700,
  });
  context.after(async () => {
    if (existsSync(join(root, "identity.json"))) {
      const ids = await identity(root);
      // Emergency cleanup is limited to identities produced by this fixture.
      for (const pid of [ids.descendant, ids.command]) {
        if (alive(pid))
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
      }
      if (alive(ids.guard)) {
        try {
          process.kill(
            process.platform === "win32" ? ids.guard : -ids.guard,
            "SIGKILL",
          );
        } catch {}
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, file, executable };
}

test("normal commands preserve output and exit codes and release listeners and slots", async (context) => {
  const { root } = await fixture(context);
  const runner = createWorkspaceCommands(entry);
  context.after(() => runner.close());
  const signal = new AbortController().signal;
  for (let index = 0; index < 12; index++) {
    const value = await runner.run({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(process.argv[1]);process.stderr.write('diagnostic');process.exitCode=7",
        "中文参数",
      ],
      cwd: root,
      signal,
    });
    assert.equal(value.stdout, "中文参数");
    assert.equal(value.stderr, "diagnostic");
    assert.equal(value.exitCode, 7);
    assert.equal(value.timedOut, false);
    assert.equal(getEventListeners(signal, "abort").length, 0);
    assert.equal(runner.snapshot().active, 0);
  }
});

test(
  "timeout kills commands and descendants that ignore SIGTERM",
  { skip: process.platform === "win32" },
  async (context) => {
    const { root, file } = await fixture(context);
    const runner = createWorkspaceCommands(entry, { timeoutMs: 500 });
    context.after(() => runner.close());
    const started = performance.now();
    const value = await runner.run({
      command: process.execPath,
      args: [file],
      cwd: root,
      signal: new AbortController().signal,
    });
    assert.equal(value.timedOut, true);
    assert.equal(value.exitCode, null);
    assert(performance.now() - started < 4000);
    await gone(await identity(root));
  },
);

test(
  "request cancellation releases the whole command group and its AbortSignal listener",
  { skip: process.platform === "win32" },
  async (context) => {
    const { root, file } = await fixture(context);
    const runner = createWorkspaceCommands(entry);
    context.after(() => runner.close());
    const controller = new AbortController();
    const pending = runner.run({
      command: process.execPath,
      args: [file],
      cwd: root,
      signal: controller.signal,
    });
    const rejection = assert.rejects(pending, /workspace_command_aborted/);
    const ids = await identity(root);
    controller.abort();
    await rejection;
    await gone(ids);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(runner.snapshot().active, 0);
  },
);

test(
  "parent command exit cannot leave descendants holding output pipes indefinitely",
  { skip: process.platform === "win32" },
  async (context) => {
    const { root, file } = await fixture(context, true);
    const runner = createWorkspaceCommands(entry);
    context.after(() => runner.close());
    const started = performance.now();
    const result = await runner.run({
      command: process.execPath,
      args: [file],
      cwd: root,
      signal: new AbortController().signal,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert(performance.now() - started < 4000);
    await gone(await identity(root));
  },
);

test(
  "a killed guard does not leave descendants waiting for the full command deadline",
  { skip: process.platform === "win32" },
  async (context) => {
    const { root, file } = await fixture(context);
    const runner = createWorkspaceCommands(entry);
    context.after(() => runner.close());
    const pending = runner.run({
      command: process.execPath,
      args: [file],
      cwd: root,
      signal: new AbortController().signal,
    });
    const rejected = assert.rejects(
      pending,
      /workspace_command_guard_(exit_stream_deadline|result_missing)/,
    );
    const ids = await identity(root),
      started = performance.now();
    process.kill(ids.guard, "SIGKILL");
    await rejected;
    await gone(ids);
    assert(performance.now() - started < 3000);
    assert.equal(runner.snapshot().active, 0);
  },
);

test(
  "command concurrency is bounded and closing cancels every occupied slot",
  { skip: process.platform === "win32" },
  async (context) => {
    const runner = createWorkspaceCommands(entry);
    context.after(() => runner.close());
    const fixtures = await Promise.all(
      Array.from({ length: 4 }, () => fixture(context)),
    );
    const pending = fixtures.map(({ root, file }) =>
      runner.run({
        command: process.execPath,
        args: [file],
        cwd: root,
        signal: new AbortController().signal,
      }),
    );
    const rejected = pending.map((promise) =>
      assert.rejects(promise, /workspace_command_aborted/),
    );
    const ids = await Promise.all(fixtures.map(({ root }) => identity(root)));
    assert.equal(runner.snapshot().active, 4);
    await assert.rejects(
      runner.run({
        command: process.execPath,
        args: [],
        cwd: fixtures[0]!.root,
        signal: new AbortController().signal,
      }),
      /workspace_command_capacity_exceeded/,
    );
    await runner.close();
    await Promise.all(rejected);
    await Promise.all(ids.map(gone));
    assert.equal(runner.snapshot().active, 0);
    await assert.rejects(
      runner.run({
        command: process.execPath,
        args: [],
        cwd: fixtures[0]!.root,
        signal: new AbortController().signal,
      }),
      /workspace_commands_closed/,
    );
  },
);

test("output storage stays bounded for noisy commands and spawn errors are explicit", async (context) => {
  const { root } = await fixture(context);
  const runner = createWorkspaceCommands(entry);
  context.after(() => runner.close());
  const result = await runner.run({
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write('x'.repeat(1024*1024));process.stderr.write('y'.repeat(1024*1024));",
    ],
    cwd: root,
    signal: new AbortController().signal,
  });
  assert.equal(result.stdout.length, 60 * 1024);
  assert.equal(result.stderr.length, 60 * 1024);
  assert.equal(result.outputTruncated, true);
  const missing = await runner.run({
    command: join(root, "missing"),
    args: [],
    cwd: root,
    signal: new AbortController().signal,
  });
  assert.equal(missing.exitCode, null);
  assert.match(missing.stderr, /ENOENT/);
  const canceled = AbortSignal.abort(new Error("already_canceled"));
  await assert.rejects(
    runner.run({
      command: process.execPath,
      args: [],
      cwd: root,
      signal: canceled,
    }),
    /already_canceled/,
  );
  assert.equal(runner.snapshot().active, 0);
});

for (const mode of ["cancel", "close", "kill"] as const) {
  test(
    `actual MCP ${mode} cleans up the command and its descendants`,
    { skip: process.platform === "win32" },
    async (context) => {
      const { root, executable } = await fixture(context);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entry],
        env: {
          PATH: process.env.PATH ?? "",
          CREWON_LOCAL_WORKSPACE_ROOT: root,
          CREWON_LOCAL_PNPM_PATH: executable,
          CREWON_LOCAL_GIT_PATH: executable,
        },
        stderr: "ignore",
      });
      const client = new Client({
        name: "command-lifetime-fixture",
        version: "1.0.0",
      });
      context.after(async () => {
        await client.close();
        await transport.close();
      });
      await client.connect(transport);
      const controller = new AbortController();
      const pending = client
        .callTool({ name: "git_status", arguments: {} }, undefined, {
          signal: controller.signal,
        })
        .catch(() => null);
      const ids = await identity(root);
      if (mode === "cancel") controller.abort();
      else if (mode === "close") await client.close();
      else process.kill(transport.pid!, "SIGKILL");
      await pending;
      controller.abort(); // Dispose this raw SDK fixture request after transport failure.
      await gone(ids);
    },
  );
}

test(
  "the staged MCP bundle includes its command guard without separate runtime files",
  { skip: process.platform === "win32" },
  async (context) => {
    const { root, executable } = await fixture(context);
    const output = join(root, "frozen", "workspace-mcp.mjs");
    await mkdir(dirname(output));
    await promisify(execFile)(
      "pnpm",
      [
        "exec",
        "esbuild",
        entry,
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--target=node24",
        "--packages=bundle",
        '--banner:js=import {createRequire as cr} from "node:module";const require=cr(import.meta.url);',
        `--outfile=${output}`,
      ],
      {
        cwd: resolve(dirname(entry), ".."),
        timeout: 30_000,
        maxBuffer: 16 * 1024,
      },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [output],
      env: {
        PATH: process.env.PATH ?? "",
        CREWON_LOCAL_WORKSPACE_ROOT: root,
        CREWON_LOCAL_PNPM_PATH: executable,
        CREWON_LOCAL_GIT_PATH: executable,
      },
      stderr: "ignore",
    });
    const client = new Client({
      name: "bundled-command-fixture",
      version: "1.0.0",
    });
    context.after(async () => {
      await client.close();
      await transport.close();
    });
    await client.connect(transport);
    const controller = new AbortController();
    const pending = client
      .callTool({ name: "git_status", arguments: {} }, undefined, {
        signal: controller.signal,
      })
      .catch(() => null);
    const ids = await identity(root);
    process.kill(transport.pid!, "SIGKILL");
    await pending;
    controller.abort();
    await gone(ids);
  },
);
