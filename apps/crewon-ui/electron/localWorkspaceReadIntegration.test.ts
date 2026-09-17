import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Bundle the actual browser client and native implementation at the integration
// boundary, keeping their separate TypeScript projects and runtime imports intact.
it("keeps repeated native previews bounded through the real desktop client", () => {
  const bundled = buildSync({
    stdin: {
      contents:
        'export { createDesktopSandboxClient } from "./src/lib/desktop/desktopSandboxClient.ts"; export { LocalWorkspaceAuthority, LocalWorkspaceSandbox } from "./electron/localWorkspace.ts";',
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    define: { "import.meta.env": "{}" },
  }).outputFiles[0]!.text;
  const root = mkdtempSync(join(tmpdir(), "crewon-native-read-client-test-"));
  try {
    const child = spawnSync(
      process.execPath,
      ["--expose-gc", "--input-type=commonjs", "-", root],
      {
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
        input:
          bundled +
          String.raw`
(async () => {
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { createDesktopSandboxClient, LocalWorkspaceAuthority, LocalWorkspaceSandbox } = module.exports;
  const root = process.argv[2];
  try {
    const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace);
    for (let i = 0; i < 400; i++) fs.writeFileSync(path.join(workspace, "entry-" + i), "x");
    const fd = fs.openSync(path.join(workspace, "large.log"), "wx");
    try { fs.writeSync(fd, Buffer.from("prefix\n")); fs.ftruncateSync(fd, 512 * 1024 * 1024); }
    finally { fs.closeSync(fd); }
    const sandbox = new LocalWorkspaceSandbox(new LocalWorkspaceAuthority(path.join(root, "profile"), workspace));
    const client = createDesktopSandboxClient(async (command, args) => {
      if (command === "desktop_sandbox_list_directory") return sandbox.listDirectory(args.path);
      if (command === "desktop_sandbox_read_file") return sandbox.readFile(args.path);
      throw new Error("unexpected_command");
    });
    const listing = await client.listSandboxDirectory("thread", "/workspace");
    assert.equal(listing.entries.length, 120); assert.equal(listing.truncated, true);
    const read = async () => {
      const view = await client.readSandboxFile("thread", "/workspace/large.log");
      assert.equal(view.path, "/workspace/large.log"); assert.equal(view.byteLength, 512 * 1024 * 1024);
      assert.equal(view.content.length, 3000); assert(view.content.startsWith("prefix\n")); assert.equal(view.truncated, true);
    };
    await read(); global.gc(); const before = process.memoryUsage(); let peakArrayBuffers = before.arrayBuffers;
    for (let i = 0; i < 200; i++) {
      await read(); peakArrayBuffers = Math.max(peakArrayBuffers, process.memoryUsage().arrayBuffers);
      assert(peakArrayBuffers - before.arrayBuffers < 8 * 1024 * 1024);
    }
    global.gc(); const after = process.memoryUsage();
    assert(after.heapUsed - before.heapUsed < 4 * 1024 * 1024);
    assert(after.arrayBuffers - before.arrayBuffers < 1024 * 1024);
    console.log(JSON.stringify({ reads: 201, fileBytes: 512 * 1024 * 1024, previewBytes: 3000, before, after, peakArrayBuffers }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
`,
      },
    );
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr || child.stdout).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    console.info("native workspace read memory", JSON.stringify(result));
    expect(result.reads).toBe(201);
    expect(result.previewBytes).toBe(3000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);
