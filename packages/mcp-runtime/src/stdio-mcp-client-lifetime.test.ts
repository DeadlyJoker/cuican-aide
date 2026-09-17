import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { StdioMcpClient } from "./stdio-mcp-client.ts";
import { McpClientRequestScope } from "./mcp-client-request-scope.ts";

const fixture = fileURLToPath(
  new URL("./fixtures/stdio-lifetime-server.mjs", import.meta.url),
);
test("reusing a caller signal for real SDK calls retains no listeners or late cancellations", async (context) => {
  const client = new StdioMcpClient({
    command: process.execPath,
    args: [fixture],
  });
  context.after(() => client.close());
  const signal = new AbortController().signal;
  await client.connect(signal);
  assert.equal(getEventListeners(signal, "abort").length, 0);
  for (let index = 0; index < 50; index++) {
    await client.listTools(undefined, signal);
    const result = await client.callTool(
      "fixture",
      {},
      { signal, timeoutMs: 5000 },
    );
    assert.equal(result.structuredContent?.cancellations, 0);
    assert.equal(getEventListeners(signal, "abort").length, 0);
  }
});

for (const mode of ["crash", "close"] as const) {
  test(`real SDK ${mode} releases a 60-second request deadline before the process exits`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "crewon-mcp-lifetime-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const startedFile = join(root, "started");
    const source = `import {StdioMcpClient} from ${JSON.stringify(new URL("./stdio-mcp-client.ts", import.meta.url).href)};
      import {getEventListeners} from 'node:events';import {existsSync} from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';
      const client=new StdioMcpClient({command:process.execPath,args:[${JSON.stringify(fixture)},${JSON.stringify(startedFile)}]});
      const signal=new AbortController().signal;await client.connect(signal);
      const pending=client.callTool('fixture',{mode:${JSON.stringify(mode === "crash" ? "crash" : "hang")}},{signal,timeoutMs:60000}).then(()=>({ok:true}),error=>({code:error.code,message:error.message}));
      ${mode === "close" ? `const until=Date.now()+3000;while(!existsSync(${JSON.stringify(startedFile)})){if(Date.now()>until)throw Error('not_started');await delay(10);}await client.close();` : ""}
      const result=await pending;await client.close();console.log(JSON.stringify({...result,listeners:getEventListeners(signal,'abort').length}));`;
    const started = performance.now();
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", source],
      { timeout: 5000, maxBuffer: 4096 },
    );
    assert(performance.now() - started < 5000);
    assert.deepEqual(JSON.parse(stdout), {
      code: -32000,
      message: "MCP error -32000: Connection closed",
      listeners: 0,
    });
  });
}

test("request scope bounds active requests and disconnect cancels them without retaining caller listeners", async () => {
  const scope = new McpClientRequestScope();
  const signals = Array.from(
    { length: 32 },
    () => new AbortController().signal,
  );
  const pending = signals.map((signal) =>
    scope.run(
      signal,
      (owned) =>
        new Promise<void>((_resolve, reject) =>
          owned.addEventListener("abort", () => reject(owned.reason), {
            once: true,
          }),
        ),
    ),
  );
  const rejected = pending.map((promise) =>
    assert.rejects(promise, /fixture_disconnect/),
  );
  await assert.rejects(
    scope.run(new AbortController().signal, async () => {}),
    /mcp_client_request_capacity_exceeded/,
  );
  scope.disconnected(new Error("fixture_disconnect"));
  await Promise.all(rejected);
  for (const signal of signals)
    assert.equal(getEventListeners(signal, "abort").length, 0);
  await scope.run(new AbortController().signal, async () => {});
  scope.close(new Error("closed"));
  await assert.rejects(
    scope.run(new AbortController().signal, async () => {}),
    /mcp_client_closed/,
  );
});
