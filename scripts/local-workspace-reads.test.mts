import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, open, rm, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  listWorkspaceDirectory,
  readWorkspaceFilePrefix,
  WORKSPACE_FILE_PREFIX_BYTES,
} from "./local-workspace-reads.mts";

test("Finder PATH without developer executables still discovers tools and reads files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "crewon-workspace-finder-"));
  await mkdir(join(root, "apps/crewon-ui/src"), { recursive: true });
  await writeFile(
    join(root, "apps/crewon-ui/src/fixture.test.ts"),
    "throw new Error('must_not_execute');",
  );
  await writeFile(join(root, "fixture.txt"), "still readable");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(
        new URL("./local-workspace-checks-mcp.mjs", import.meta.url),
      ),
    ],
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      CREWON_LOCAL_WORKSPACE_ROOT: root,
      CREWON_LOCAL_PNPM_PATH: "pnpm",
      CREWON_LOCAL_GIT_PATH: "git",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "finder-startup", version: "1.0.0" });
  context.after(async () => {
    await client.close();
    await transport.close();
    await rm(root, { recursive: true, force: true });
  });
  await client.connect(transport);
  const catalog = await client.listTools();
  assert.deepEqual(catalog.tools.map((tool) => tool.name).sort(), [
    "git_status",
    "list_files",
    "read_file",
    "run_ui_test",
  ]);
  for (const [name, args, error] of [
    ["git_status", {}, "local_git_path_invalid"],
    [
      "run_ui_test",
      { testFile: "src/fixture.test.ts" },
      "local_pnpm_path_invalid",
    ],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { error });
  }
  const read = await client.callTool({
    name: "read_file",
    arguments: { path: "fixture.txt" },
  });
  assert.equal(read.isError, false);
  assert.equal(
    (read.structuredContent as { content: string }).content,
    "still readable",
  );
});

test("small, boundary, empty and cut UTF-8 files preserve the existing response shape", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "crewon-workspace-read-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from("短文件"),
    Buffer.alloc(WORKSPACE_FILE_PREFIX_BYTES, 97),
    Buffer.from("汉".repeat(9000)),
  ]) {
    const file = join(root, "fixture");
    await writeFile(file, bytes);
    assert.deepEqual(await readWorkspaceFilePrefix(file), {
      content: bytes.subarray(0, WORKSPACE_FILE_PREFIX_BYTES).toString("utf8"),
      byteLength: bytes.length,
      truncated: bytes.length > WORKSPACE_FILE_PREFIX_BYTES,
    });
  }
  await assert.rejects(readWorkspaceFilePrefix(root), /workspace_path_invalid/);
});

test("a 256 MiB sparse file only reads a 24 KiB prefix in an isolated process", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "crewon-workspace-large-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "sparse"),
    handle = await open(file, "wx");
  try {
    await handle.write(Buffer.from("fixture"));
    await handle.truncate(256 * 1024 ** 2);
  } finally {
    await handle.close();
  }
  const module = new URL("./local-workspace-reads.mts", import.meta.url).href;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { readWorkspaceFilePrefix } from ${JSON.stringify(module)};
    const before=process.resourceUsage().maxRSS; const value=await readWorkspaceFilePrefix(process.argv[1]);
    console.log(JSON.stringify({prefix:value.content.slice(0,7),length:Buffer.byteLength(value.content),byteLength:value.byteLength,truncated:value.truncated,peakGrowthKiB:process.resourceUsage().maxRSS-before}));`,
      file,
    ],
    { timeout: 10000, maxBuffer: 4096 },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.prefix, "fixture");
  assert.equal(result.length, WORKSPACE_FILE_PREFIX_BYTES);
  assert.equal(result.byteLength, 256 * 1024 ** 2);
  assert.equal(result.truncated, true);
  assert(
    result.peakGrowthKiB < 64 * 1024,
    `unexpected peak growth: ${result.peakGrowthKiB} KiB`,
  );
});

test("directory selection retains the sorted first 200 entries and excludes symlinks", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "crewon-workspace-list-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const expected: { name: string; kind: "directory" | "file" }[] = [];
  for (let index = 240; index >= 0; index--) {
    const name = `entry-${String(index).padStart(3, "0")}`,
      directory = index % 5 === 0;
    if (directory) await mkdir(join(root, name));
    else await writeFile(join(root, name), "");
    expected.push({ name, kind: directory ? "directory" : "file" });
  }
  await symlink(join(root, "entry-001"), join(root, "alias"));
  expected.sort((left, right) =>
    left.kind === right.kind
      ? left.name.localeCompare(right.name)
      : left.kind === "directory"
        ? -1
        : 1,
  );
  assert.deepEqual(await listWorkspaceDirectory(root), {
    entries: expected.slice(0, 200),
    truncated: true,
  });
});

test("oversized directories fail with a work-budget error instead of silently returning the wrong first page", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "crewon-workspace-many-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (let index = 0; index <= 10_000; index++)
    writeFileSync(join(root, String(index)), "");
  await assert.rejects(
    listWorkspaceDirectory(root),
    /workspace_directory_scan_(limit|deadline)_exceeded/,
  );
});

test("already canceled reads reject before opening filesystem resources", async () => {
  const signal = AbortSignal.abort(new Error("fixture_canceled"));
  await assert.rejects(
    readWorkspaceFilePrefix("/does-not-exist", { signal }),
    /fixture_canceled/,
  );
  await assert.rejects(
    listWorkspaceDirectory("/does-not-exist", { signal }),
    /fixture_canceled/,
  );
});

test("the real stdio MCP entry returns bounded reads and keeps workspace escape checks", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "crewon-workspace-mcp-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "fixture.txt"), "real MCP fixture");
  await writeFile(join(root, "outside.txt"), "outside");
  await symlink(join(root, "outside.txt"), join(workspace, "escape"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(
        new URL("./local-workspace-checks-mcp.mjs", import.meta.url),
      ),
    ],
    env: {
      PATH: process.env.PATH ?? "",
      CREWON_LOCAL_WORKSPACE_ROOT: workspace,
      CREWON_LOCAL_PNPM_PATH: process.execPath,
      CREWON_LOCAL_GIT_PATH: process.execPath,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "bounded-read-fixture", version: "1.0.0" });
  context.after(async () => {
    await client.close();
    await transport.close();
    await rm(root, { recursive: true, force: true });
  });
  await client.connect(transport);
  const read = await client.callTool({
    name: "read_file",
    arguments: { path: "fixture.txt" },
  });
  assert.deepEqual(read.structuredContent, {
    path: "fixture.txt",
    content: "real MCP fixture",
    byteLength: 16,
    truncated: false,
  });
  assert.equal(read.isError, false);
  const escaped = await client.callTool({
    name: "read_file",
    arguments: { path: "escape" },
  });
  assert.equal(escaped.isError, true);
  const listed = await client.callTool({
    name: "list_files",
    arguments: { path: "." },
  });
  assert.deepEqual(listed.structuredContent, {
    path: ".",
    entries: [{ name: "fixture.txt", kind: "file" }],
    truncated: false,
  });
});
