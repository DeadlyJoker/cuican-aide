import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioMcpClient } from "./stdio-mcp-client.ts";

test(
  "all close callers join a real child while initialization is pending",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const connecting = assert.rejects(
      f.client.connect(new AbortController().signal),
      /closed|aborted|Connection closed/,
    );
    const pid = await f.pid();
    const close = f.client.close();
    assert.equal(f.client.close(), close);
    await Promise.all([connecting, close]);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(f.client.close(), close);
    await assert.rejects(
      f.client.connect(new AbortController().signal),
      /mcp_client_closed/,
    );
  },
);

test(
  "SDK returning without child exit is an unconfirmed close, never a successful release",
  { timeout: 12000 },
  async (t) => {
    const f = await fixture(t);
    const connecting = assert.rejects(
      f.client.connect(new AbortController().signal),
      /closed|aborted|Connection closed/,
    );
    const pid = await f.pid();
    const original = StdioClientTransport.prototype.close;
    let transport!: StdioClientTransport;
    const mocked = t.mock.method(
      StdioClientTransport.prototype,
      "close",
      async function (this: StdioClientTransport) {
        transport = this;
      },
    );
    try {
      const close = f.client.close();
      assert.equal(f.client.close(), close);
      await assert.rejects(close, /mcp_process_close_unconfirmed/);
      await connecting;
      assert.doesNotThrow(() => process.kill(pid, 0));
      await assert.rejects(f.client.close(), /mcp_process_close_unconfirmed/);
    } finally {
      mocked.mock.restore();
      await original.call(transport);
    }
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  },
);

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "crewon-stdio-creation-"));
  const pidFile = join(root, "pid");
  let childPid = 0;
  const client = new StdioMcpClient({
    command: process.execPath,
    args: [
      fileURLToPath(
        new URL("./fixtures/creation-cleanup-server.mjs", import.meta.url),
      ),
      pidFile,
      "initializeHang",
    ],
  });
  t.after(async () => {
    try {
      await client.close();
    } catch {
      if (childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {}
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  return {
    client,
    pid: async () => {
      const until = Date.now() + 5000;
      while (!childPid) {
        try {
          childPid = Number(await readFile(pidFile, "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (Date.now() > until) assert.fail("stdio fixture did not start");
        if (!childPid) await delay(5);
      }
      return childPid;
    },
  };
}
