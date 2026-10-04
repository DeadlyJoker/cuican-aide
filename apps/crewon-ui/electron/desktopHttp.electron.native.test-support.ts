/** Test-only hidden Electron transport assembly. The formal Main is not imported:
 * its private registerIpc/requireMainRenderer are outside this proof's scope. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { DesktopHttpTransport } from "./desktopHttp.ts";
import { desktopHttpReply } from "./desktopHttpReply.ts";
import { bindDesktopHttpLifetime } from "./desktopHttpLifetime.ts";
import type { DesktopHttpRequest } from "../src/lib/desktop/desktopBridge.ts";

type Case = Readonly<{
  name: string;
  url: string;
  method: "GET" | "POST";
  body: string | null;
  expected: string;
}>;
type Configuration = Readonly<{
  userData: string;
  preload: string;
  document: string;
  rendererModule: string;
  proof: string;
  cases: readonly Case[];
}>;
type IpcObservation = Readonly<{
  phase: "open" | "read" | "abort";
  name: string;
  elapsedMs: number;
  result: "headers" | "chunk" | "end" | "abort" | "error";
  bytes?: number;
  status?: number;
}>;
const configuration = JSON.parse(
  readFileSync(process.argv[2], "utf8"),
) as Configuration;
app.setPath("userData", configuration.userData);
if (process.platform === "darwin") app.setActivationPolicy("accessory");
const observations: IpcObservation[] = [];
const requests = new Map<string, string>();
const transport = new DesktopHttpTransport();
let window: BrowserWindow | undefined;
let failure: unknown;

async function run(): Promise<void> {
  await app.whenReady();
  if (process.platform === "darwin") app.hide();
  window = new BrowserWindow({
    show: false,
    focusable: false,
    webPreferences: {
      preload: configuration.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  const ownedWindow = window;
  let shown = false,
    focused = false;
  ownedWindow.on("show", () => {
    shown = true;
  });
  ownedWindow.on("focus", () => {
    focused = true;
  });
  const handle = <T>(
    channel: string,
    operation: (input: T) => unknown | Promise<unknown>,
  ) =>
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, input: T) => {
      // Same identity comparison as the private Main guard; test-owned registration.
      if (
        event.sender !== ownedWindow.webContents ||
        event.senderFrame !== ownedWindow.webContents.mainFrame
      )
        throw new Error("desktop_ipc_sender_invalid");
      return operation(input);
    });
  handle<DesktopHttpRequest>("crewon:http:open-v2", async (request) => {
    const testCase = configuration.cases.find(
      (item) => item.url === request.url && item.method === request.method,
    );
    assert.ok(testCase, "only_owned_loopback_cases_are_permitted");
    requests.set(request.requestId, testCase.name);
    const started = performance.now();
    const reply = await desktopHttpReply(() => transport.fetch(request));
    observations.push({
      phase: "open",
      name: testCase.name,
      elapsedMs: performance.now() - started,
      result: reply.ok ? "headers" : "error",
      ...(reply.ok ? { status: reply.value.status } : {}),
    });
    return reply;
  });
  handle<string>("crewon:http:read-v2", async (requestId) => {
    const started = performance.now();
    const reply = await desktopHttpReply(() => transport.read(requestId));
    observations.push({
      phase: "read",
      name: requests.get(requestId) ?? "unknown",
      elapsedMs: performance.now() - started,
      result: reply.ok ? reply.value.type : "error",
      ...(reply.ok && reply.value.type === "chunk"
        ? { bytes: reply.value.chunk.byteLength }
        : {}),
    });
    return reply;
  });
  handle<string>("crewon:http:abort-v2", async (requestId) => {
    const started = performance.now();
    const reply = await desktopHttpReply(() => transport.abort(requestId));
    observations.push({
      phase: "abort",
      name: requests.get(requestId) ?? "unknown",
      elapsedMs: performance.now() - started,
      result: reply.ok ? "abort" : "error",
    });
    return reply;
  });
  bindDesktopHttpLifetime(ownedWindow.webContents, transport);
  await ownedWindow.loadFile(configuration.document);
  assert.equal(ownedWindow.isVisible(), false);
  assert.equal(ownedWindow.isFocused(), false);
  assert.equal(shown, false);
  assert.equal(focused, false);
  const renderer = await ownedWindow.webContents.executeJavaScript(`(async()=>{
    if(typeof window.require!=='undefined'||typeof window.process!=='undefined')
      throw new Error('renderer_node_exposed');
    if(window.crewonDesktop?.version!==1||window.crewonDesktop.http?.version!==2)
      throw new Error('original_preload_missing');
    const original=await import(${JSON.stringify(configuration.rendererModule)});
    const platformFetch=globalThis.fetch;
    await original.installDesktopFetch();
    if(globalThis.fetch===platformFetch||globalThis.fetch[Symbol.for('crewon.desktopFetch')]!==true)
      throw new Error('original_global_delegate_missing');
    const rows=[];
    for(const item of ${JSON.stringify(configuration.cases)}) {
      const started=performance.now();
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),5000);
      try {
        const response=await globalThis.fetch(item.url,{
          method:item.method,
          ...(item.body===null?{}:{body:item.body,headers:{'Content-Type':'application/json'}}),
          signal:controller.signal,redirect:'manual'
        });
        const headersAt=performance.now();
        const text=await response.text();
        const endAt=performance.now();
        if(response.status!==200||text!==item.expected) throw new Error('owned_eof_mismatch');
        rows.push({name:item.name,status:response.status,characters:text.length,
          headersMs:headersAt-started,bodyMs:endAt-headersAt,totalMs:endAt-started});
      } finally {clearTimeout(timer);}
    }
    // Probe the actual shared budget without reading or changing private counters.
    // All 24 read + 8 write slots and all 16MiB request bytes must be available.
    const leases=[];
    let activeBoundary=false,byteBoundary=false;
    try {
      for(let i=0;i<32;i++) leases.push(original.acquireDesktopHttpRequest(i<24?'read':'write'));
      try {original.acquireDesktopHttpRequest('write');}
      catch(error) {activeBoundary=error.message==='desktop_http_capacity';}
      for(let i=0;i<8;i++) leases[i].reserve(2*1024*1024);
      try {leases[8].reserve(1);}
      catch(error) {byteBoundary=error.message==='desktop_http_capacity';}
    } finally {for(const lease of leases) lease.release();}
    if(!activeBoundary||!byteBoundary) throw new Error('renderer_budget_not_empty');
    return {cases:rows,originalPreload:true,chromiumGlobalDelegate:true,
      rendererNodeAbsent:true,budgetZeroVerified:true,userAgent:navigator.userAgent};
  })()`);
  assert.equal(ownedWindow.isVisible(), false);
  assert.equal(ownedWindow.isFocused(), false);
  assert.equal(shown, false);
  assert.equal(focused, false);
  assert.deepEqual(transport.usage, {
    activeRequests: 0,
    requestBytes: 0,
    globalActiveRequests: 0,
    globalReadRequests: 0,
    globalRequestBytes: 0,
  });
  assert.ok(observations.length <= 64);
  for (const item of configuration.cases) {
    const rows = observations.filter((row) => row.name === item.name);
    assert.equal(rows.filter((row) => row.phase === "open").length, 1);
    assert.equal(rows.at(-1)?.result, "end");
    assert.ok(rows.every((row) => row.result !== "error"));
  }
  const proof = {
    schemaVersion: "crewon.test.hidden-electron-http-eof.v1",
    pid: process.pid,
    electronVersion: process.versions.electron,
    chromiumVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    windowNeverVisible: true,
    windowNeverFocused: true,
    formalMainRegistrationCovered: false,
    controlBusinessRequests: 0,
    supplierRequests: 0,
    modelRequests: 0,
    renderer,
    ipc: observations,
    mainUsage: transport.usage,
  };
  writeFileSync(configuration.proof, JSON.stringify(proof, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  console.log("CREWON_HIDDEN_ELECTRON_HTTP_PROOF:" + JSON.stringify(proof));
}

void run()
  .catch((error) => {
    failure = error;
    console.error(
      "CREWON_HIDDEN_ELECTRON_HTTP_FAILURE:" +
        (error instanceof Error ? error.message : "unknown"),
    );
    process.exitCode = 1;
  })
  .finally(() => {
    transport.close();
    for (const channel of [
      "crewon:http:open-v2",
      "crewon:http:read-v2",
      "crewon:http:abort-v2",
    ])
      ipcMain.removeHandler(channel);
    window?.destroy();
    if (failure === undefined) app.quit();
    else app.exit(1);
  });
