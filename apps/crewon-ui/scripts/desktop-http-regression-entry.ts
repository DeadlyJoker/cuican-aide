import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopHttpTransport } from "../electron/desktopHttp.ts";
import { bindDesktopHttpLifetime } from "../electron/desktopHttpLifetime.ts";
import { desktopHttpReply } from "../electron/desktopHttpReply.ts";
import type { DesktopHttpRequest } from "../src/lib/desktop/desktopBridge.ts";

const root = process.env.CREWON_HTTP_FIXTURE_ROOT!;
if (!root) throw Error("fixture_root_missing");
mkdirSync(join(root, "profile"));
app.setPath("userData", join(root, "profile"));
const transport = new DesktopHttpTransport();
const calls = { opens: 0, reads: 0, aborts: 0, bytes: 0 };
let window: BrowserWindow | null = null;
let producedBytes = 0,
  connections = 0;
const controlCursors: (string | null)[] = [];
const server = createServer((request, response) => {
  const path = request.url!;
  if (path.startsWith("/api/v1/runs/fixture/events?")) {
    assert.equal(
      request.headers.authorization,
      "Bearer synthetic-control-token",
    );
    const cursor =
      typeof request.headers["last-event-id"] === "string"
        ? request.headers["last-event-id"]
        : null;
    controlCursors.push(cursor);
    const sequence = cursor === "1" ? 2 : 1;
    const event = {
      eventId: `event-${sequence}`,
      runId: "fixture",
      sequence,
      occurredAt: "2026-09-11T00:00:00Z",
      type: sequence === 1 ? "run.started" : "run.completed",
      data: sequence === 1 ? {} : { outputRef: null },
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const frame = `id: ${sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    if (sequence === 1) {
      response.write(frame);
      setTimeout(() => response.destroy(), 100);
    } else response.end(frame);
    return;
  }
  if (path.startsWith("/large")) {
    connections++;
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.flushHeaders();
    let remaining = 8 * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 37);
    const write = () => {
      while (remaining && !response.destroyed) {
        remaining -= chunk.length;
        producedBytes += chunk.length;
        if (!response.write(chunk)) {
          response.once("drain", write);
          return;
        }
      }
      if (!response.destroyed) response.end();
    };
    write();
    return;
  }
  if (path === "/idle") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    return;
  }
  if (path === "/event") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const cursor = request.headers["last-event-id"];
    if (cursor === "1") response.end("id: 2\ndata: resumed中😀\n\n");
    else {
      response.write("id: 1\ndata: first中😀\n\n");
      setTimeout(() => response.destroy(), 100);
    }
    return;
  }
  if (path === "/echo") {
    let bytes = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      assert.equal(request.method, "POST");
      assert.equal(request.headers.origin, "http://crewon.localhost");
      response.end(Buffer.concat(chunks));
    });
    return;
  }
  if (path === "/empty") {
    response.writeHead(204);
    response.end();
    return;
  }
  response.end("fresh");
});
const evaluate = (code: string) =>
  window!.webContents.executeJavaScript(code, true);
async function settled() {
  for (let i = 0; i < 100 && transport.usage.activeRequests; i++)
    await delay(10);
  assert.equal(transport.usage.activeRequests, 0);
}
async function heap() {
  const debug = window!.webContents.debugger;
  debug.attach("1.3");
  try {
    await debug.sendCommand("HeapProfiler.collectGarbage");
    return await debug.sendCommand("Runtime.getHeapUsage");
  } finally {
    debug.detach();
  }
}
async function run() {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error();
  const origin = `http://127.0.0.1:${address.port}`;
  window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(root, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  bindDesktopHttpLifetime(window.webContents, transport);
  const handle = <T>(name: string, callback: (value: T) => unknown) =>
    ipcMain.handle(name, (event, value) => {
      if (
        event.sender !== window!.webContents ||
        event.senderFrame !== window!.webContents.mainFrame
      )
        throw Error("fixture_sender_invalid");
      return desktopHttpReply(() => callback(value as T));
    });
  handle("crewon:http:open-v2", (request: DesktopHttpRequest) => {
    calls.opens++;
    return transport.fetch(request);
  });
  handle("crewon:http:read-v2", async (id: string) => {
    calls.reads++;
    const part = await transport.read(id);
    if (part.type === "chunk") calls.bytes += part.chunk.byteLength;
    return part;
  });
  handle("crewon:http:abort-v2", (id: string) => {
    calls.aborts++;
    transport.abort(id);
  });
  await window.loadFile(join(root, "index.html"));
  const base = JSON.stringify(origin);
  const before = await heap();
  await evaluate(
    `(async()=>{window.responses=await Promise.all(Array.from({length:8},(_,i)=>fixtureFetch(${base}+'/large/'+i)));return responses.length;})()`,
  );
  await delay(300);
  assert.equal(transport.usage.activeRequests, 8);
  assert.equal(calls.reads, 0);
  const paused = await heap();
  const pausedProducedBytes = producedBytes;
  assert.ok(
    paused.backingStorageSize - before.backingStorageSize < 4 * 1024 * 1024,
  );
  await evaluate(
    "Promise.all(responses.map(response=>response.body.cancel())).then(()=>{window.responses=null;return true;})",
  );
  await settled();
  const canceled = await heap();
  const roundTrip = await evaluate(
    `(async()=>{const bytes=Uint8Array.from({length:256*1024},(_,i)=>i%256);const response=await fixtureFetch(${base}+'/echo',{method:'POST',headers:{Origin:'http://crewon.localhost'},body:bytes});const actual=new Uint8Array(await response.arrayBuffer());return {bytes:actual.length,equal:actual.every((byte,i)=>byte===bytes[i])};})()`,
  );
  assert.deepEqual(roundTrip, { bytes: 256 * 1024, equal: true });
  await settled();
  const stream = await evaluate(
    `(async()=>{const response=await fixtureFetch(${base}+'/event');const reader=response.body.getReader();const decoder=new TextDecoder();let text='',failed=false;try{for(;;){const part=await reader.read();if(part.done)break;text+=decoder.decode(part.value,{stream:true});}}catch{failed=true;}finally{reader.releaseLock();}const resumed=await(await fixtureFetch(${base}+'/event',{headers:{'Last-Event-ID':'1'}})).text();return {text,failed,resumed};})()`,
  );
  assert.equal(stream.failed, true);
  assert.equal(stream.text, "id: 1\ndata: first中😀\n\n");
  assert.equal(stream.resumed, "id: 2\ndata: resumed中😀\n\n");
  await settled();
  const controlStream = await evaluate(
    `(async()=>{const client=new fixtureControlClient({baseUrl:${base},accessToken:'synthetic-control-token',fetch:fixtureFetch});const events=[];let failed=false;try{for await(const event of fixtureRunEvents(client,{runId:'fixture'}))events.push(event);}catch{failed=true;}for await(const event of fixtureRunEvents(client,{runId:'fixture',afterSequence:events.at(-1).sequence}))events.push(event);return {failed,sequences:events.map(e=>e.sequence),types:events.map(e=>e.type)};})()`,
  );
  assert.deepEqual(controlStream, {
    failed: true,
    sequences: [1, 2],
    types: ["run.started", "run.completed"],
  });
  assert.deepEqual(controlCursors, [null, "1"]);
  await settled();
  const cancellation = await evaluate(
    `(async()=>{const controller=new AbortController();const response=await fixtureFetch(new Request(${base}+'/idle',{signal:controller.signal}));const reader=response.body.getReader();const pending=reader.read().then(()=>false,()=>true);controller.abort();const rejected=await pending;reader.releaseLock();return rejected;})()`,
  );
  assert.equal(cancellation, true);
  await settled();
  const large = await evaluate(
    `(async()=>{const started=performance.now();const response=await fixtureFetch(${base}+'/large/consumed');const reader=response.body.getReader();let bytes=0,maxChunk=0;for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;maxChunk=Math.max(maxChunk,part.value.length);if(part.value.some(x=>x!==37))throw Error('corrupt');}reader.releaseLock();return{bytes,maxChunk,elapsedMs:performance.now()-started};})()`,
  );
  assert.equal(large.bytes, 8 * 1024 * 1024);
  assert.ok(large.maxChunk <= 64 * 1024);
  await settled();
  const empty = await evaluate(
    `fixtureFetch(${base}+'/empty').then(response=>response.body===null)`,
  );
  assert.equal(empty, true);
  await settled();
  const capacity = await evaluate(
    `(async()=>{window.responses=await Promise.all(Array.from({length:24},()=>fixtureFetch(${base}+'/idle')));let rejected=false;try{await fixtureFetch(${base}+'/fresh');}catch(error){rejected=error.message.includes('desktop_http_capacity');}const write=await(await fixtureFetch(${base}+'/echo',{method:'POST',headers:{Origin:'http://crewon.localhost'},body:'cancel-slot-fixture'})).text();await Promise.all(responses.map(response=>response.body.cancel()));window.responses=null;return{rejected,write};})()`,
  );
  assert.deepEqual(capacity, { rejected: true, write: "cancel-slot-fixture" });
  await settled();
  await evaluate(
    `(async()=>{window.responses=await Promise.all(Array.from({length:8},()=>fixtureFetch(${base}+'/idle')));return true;})()`,
  );
  assert.equal(transport.usage.activeRequests, 8);
  const loaded = once(window.webContents, "did-finish-load");
  window.webContents.reload();
  await loaded;
  await settled();
  assert.equal(
    await evaluate(
      `fixtureFetch(${base}+'/fresh').then(response=>response.text())`,
    ),
    "fresh",
  );
  await settled();
  const result = {
    completedAt: new Date().toISOString(),
    electron: process.versions.electron,
    node: process.versions.node,
    checks: {
      pausedStreams: 8,
      unreadBodyIpcReads: 0,
      binaryRoundTrip: true,
      splitUtf8AndReconnect: true,
      requestSignalAbort: true,
      bodyless: true,
      reloadReleasesAll: true,
      querySaturationPreservesWrites: true,
      controlClientDurableCursor: true,
    },
    before,
    paused,
    canceled,
    pausedProducedBytes,
    connections,
    large,
    calls,
    finalUsage: transport.usage,
    caveat:
      "Explicit fixture GC; the backing-storage check covers renderer buffers, not kernel/network/process RSS. The 8 MiB latency has no old-transport control and is not a speedup claim.",
  };
  writeFileSync(
    join(root, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
}
app
  .whenReady()
  .then(run)
  .then(() => {
    transport.close();
    server.closeAllConnections();
    server.close();
    window?.destroy();
    app.quit();
  })
  .catch((error) => {
    writeFileSync(join(root, "failure.txt"), String(error.stack ?? error));
    transport.close();
    server.closeAllConnections();
    server.close();
    window?.destroy();
    app.exit(1);
  });
