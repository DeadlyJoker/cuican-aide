import { app, BrowserWindow } from "electron";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startSoakMetrics } from "./metrics.ts";
import { createRendererHeapAudit } from "./renderer-heap.ts";
import { createSoakLifecycle } from "./lifecycle.ts";

const root = process.env.CREWON_SOAK_ROOT!;
const token = process.env.CREWON_SOAK_CONTROL_TOKEN!;
if (!root || !/^[a-f0-9]{64}$/.test(token ?? ""))
  throw new Error("soak_configuration_missing");
mkdirSync(join(root, "profile"), { recursive: true, mode: 0o700 });
app.setPath("userData", join(root, "profile"));
app.setName("CrewON isolated endurance test");
const lifecycle = createSoakLifecycle(root);
lifecycle("entry");
app.on("before-quit", () => lifecycle("before-quit"));
app.on("will-quit", () => lifecycle("will-quit"));
app.on("quit", (_event, exitCode) => lifecycle("quit", { exitCode }));
app.on("child-process-gone", (_event, details) =>
  lifecycle("child-process-gone", {
    exitCode: details.exitCode,
    reason: details.reason,
  }),
);
process.once("exit", (exitCode) => lifecycle("process-exit", { exitCode }));
const metrics = startSoakMetrics(join(root, "metrics"), "electron");
app.on("browser-window-created", (_event, window) => {
  const details = { windowId: window.id };
  lifecycle("window-created", details);
  window.on("close", () => lifecycle("window-close", details));
  window.on("closed", () => lifecycle("window-closed", details));
  window.on("unresponsive", () => lifecycle("window-unresponsive", details));
  window.on("responsive", () => lifecycle("window-responsive", details));
  window.webContents.on("render-process-gone", (_event, gone) =>
    lifecycle("renderer-gone", {
      ...details,
      exitCode: gone.exitCode,
      reason: gone.reason,
    }),
  );
  window.once("ready-to-show", () => queueMicrotask(() => window.hide()));
});
await import(
  pathToFileURL(join(root, "frozen/apps/crewon-ui/dist-electron/main.mjs")).href
);
// The product entry owns whenReady; awaiting it at the entry's top level would
// keep Electron's ESM startup pending and prevent the ready event itself.
const window = () => {
  const result = BrowserWindow.getAllWindows()[0];
  if (
    !result ||
    result.isDestroyed() ||
    !result.webContents.getURL().startsWith("file:")
  )
    throw new Error("soak_window_unavailable");
  return result;
};
const evaluate = (code: string) =>
  window().webContents.executeJavaScript(code, true) as Promise<unknown>;
const captureHeap = createRendererHeapAudit(
  root,
  () => window().webContents.debugger,
);
let busy = false;
const server = createServer((request, response) => {
  if (
    request.headers.authorization !== `Bearer ${token}` ||
    request.method !== "POST"
  ) {
    response.writeHead(403);
    response.end();
    return;
  }
  if (busy) {
    response.writeHead(429);
    response.end();
    return;
  }
  busy = true;
  void (async () => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 16_384) throw new Error("soak_command_too_large");
      chunks.push(chunk);
    }
    const command = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      action: string;
      text?: string;
      threadId?: string;
      label?: "warm" | "final";
    };
    let result: unknown;
    switch (command.action) {
      case "rendererHeap":
        if (process.env.CREWON_SOAK_RENDERER_HEAP !== "1" || !command.label)
          throw new Error("soak_heap_not_enabled");
        result = await captureHeap(command.label);
        break;
      case "state": {
        const w = window();
        result = {
          pid: process.pid,
          visible: w.isVisible(),
          main: metrics.snapshot(),
          processes: app.getAppMetrics(),
          renderer:
            await evaluate(`({url:location.href,hidden:document.hidden,ready:document.readyState,
            nodes:document.getElementsByTagName('*').length,
            heap:performance.memory?{used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize}:null,
            composer:!!document.querySelector('textarea[data-od-id="composer-input"]'),
            login:!!document.querySelector('form.crewon-auth-form'),
            threads:Array.from(document.querySelectorAll('[data-linked-thread-id]')).slice(0,12).map(e=>({id:e.dataset.linkedThreadId,selected:e.classList.contains('active'),title:e.innerText.slice(0,100)}))})`),
        };
        break;
      }
      case "session":
        result = await evaluate("window.crewonDesktop.runtime.bootstrap()");
        break;
      case "login": {
        result = await evaluate(
          `(()=>{const f=document.querySelector('form.crewon-auth-form');if(!f)throw Error('login_unavailable');f.querySelector('[name=username]').value='soak-fixture';f.querySelector('[name=password]').value='Synthetic-fixture-only1';f.requestSubmit();return true})()`,
        );
        break;
      }
      case "ack": {
        if (
          typeof command.text !== "string" ||
          !/^SOAK-[A-Za-z0-9_-]+$/.test(command.text)
        )
          throw new Error("soak_marker_invalid");
        result = await evaluate(
          `({ack:Array.from(document.querySelectorAll('.message p')).some(e=>e.textContent===${JSON.stringify(`ACK ${command.text}`)})})`,
        );
        break;
      }
      case "submit": {
        if (
          typeof command.text !== "string" ||
          !/^SOAK-[A-Za-z0-9_-]+/.test(command.text) ||
          command.text.length > 1024
        )
          throw new Error("soak_input_invalid");
        const text = JSON.stringify(command.text);
        await evaluate(
          `(()=>{const e=document.querySelector('textarea[data-od-id="composer-input"]');if(!e||e.disabled)throw Error('composer_unavailable');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${text});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
        );
        await delay(100);
        result = await evaluate(
          `(()=>{const e=document.querySelector('textarea[data-od-id="composer-input"]');const f=e?.closest('form');if(!f||e.disabled)throw Error('composer_unavailable');const b=f.querySelector('button[type="submit"]');if(b?.disabled)throw Error('submit_disabled');f.requestSubmit();return true})()`,
        );
        break;
      }
      case "select": {
        if (
          typeof command.threadId !== "string" ||
          command.threadId.length > 512
        )
          throw new Error("soak_thread_invalid");
        result = await evaluate(
          `(()=>{const e=Array.from(document.querySelectorAll('[data-linked-thread-id]')).find(e=>e.dataset.linkedThreadId===${JSON.stringify(command.threadId)});if(!e)throw Error('thread_not_in_page');e.click();return true})()`,
        );
        break;
      }
      case "show":
        lifecycle("control-show");
        window().showInactive();
        result = true;
        break;
      case "hide":
        lifecycle("control-hide");
        window().hide();
        result = true;
        break;
      case "reload":
        lifecycle("control-reload");
        window().webContents.reload();
        result = true;
        break;
      case "screenshot":
        writeFileSync(
          join(root, "screen.png"),
          (await window().capturePage()).toPNG(),
        );
        result = true;
        break;
      case "shutdown":
        lifecycle("control-shutdown");
        result = true;
        setTimeout(() => app.quit(), 25);
        break;
      default:
        throw new Error("soak_action_invalid");
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  })()
    .catch((error) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "soak_control_failed",
        }),
      );
    })
    .finally(() => {
      busy = false;
    });
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("soak_control_address_missing");
writeFileSync(
  join(root, "controller.json"),
  JSON.stringify({
    pid: process.pid,
    origin: `http://127.0.0.1:${address.port}`,
  }),
  { mode: 0o600, flag: "wx" },
);
app.on("before-quit", () => {
  server.closeAllConnections();
  server.close();
  metrics.close();
});
