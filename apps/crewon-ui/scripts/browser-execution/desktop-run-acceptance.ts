import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { ControlApiClient } from "@crewon/control-client";
import { RecordingHost } from "../../electron/recordingHost.ts";
import {
  RuntimeSupervisor,
  runtimePaths,
} from "../../electron/runtimeSupervisor.ts";
import { startDesktopBrowserExecution } from "../../electron/browserExecutionDesktop.ts";

// The model and business page are explicit fixtures. Control, Worker, F02 host,
// Puppeteer actions, browser download, and F01 persistence use production code.
const output = resolve(
  process.env.CREWON_F05_EVIDENCE_DIR ?? "artifacts/f05-browser-execution",
);
mkdirSync(output, { recursive: true });
const data = mkdtempSync(join(tmpdir(), "crewon-f05-desktop-run-"));
app.setPath("userData", data);
app
  .whenReady()
  .then(async () => {
    const csv = "order_id,amount\nA101,110.00\nA103,90.00\n";
    const expectedDigest = `sha256:${createHash("sha256").update(csv).digest("hex")}`;
    const requests: unknown[] = [];
    const results: Record<string, unknown>[] = [];
    let downloads = 0;
    let step = 0;
    let observation: any;
    const modelPlan = [
      ["observe"],
      ["fill", "日期", "2026-09"],
      ["observe"],
      ["select", "渠道", "partner"],
      ["observe"],
      ["click", "筛选"],
      ["observe"],
      ["download", "下载订单"],
      ["catalog"],
    ];
    const server = createServer(async (request, response) => {
      try {
        if (request.url === "/export") {
          downloads++;
          response.writeHead(200, {
            "content-type": "text/csv",
            "content-disposition": 'attachment; filename="orders.csv"',
          });
          response.end(csv);
          return;
        }
        if (request.url === "/v1/responses") {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString());
          requests.push(body);
          for (const item of body.input ?? []) {
            if (item.type !== "function_call_output") continue;
            let value: any;
            try {
              value = JSON.parse(item.output);
            } catch {
              continue;
            }
            if (value.schemaVersion === "crewon.browser-observation.v1")
              observation = value;
            if (value.error || value.code?.startsWith("browser_"))
              throw new Error(`fixture_tool_failed:${JSON.stringify(value)}`);
            results.push(value);
          }
          const instruction = modelPlan[step];
          let name: string | undefined;
          let input: Record<string, unknown> = {};
          if (instruction) {
            const [action, targetName, value] = instruction;
            if (action === "observe") name = "crewon_browser_observe";
            else if (action === "catalog") {
              name = "delivery_catalog";
              input = { kind: "inputs", offset: 0, limit: 100 };
            } else {
              assert(
                observation,
                "observation must come from a real tool result",
              );
              const target = observation.targets.filter(
                (t: any) => t.name === targetName,
              );
              assert.equal(target.length, 1);
              name = "crewon_browser_act";
              input = {
                sessionId: observation.sessionId,
                generation: observation.generation,
                observationId: observation.observationId,
                action,
                target: { targetId: target[0].targetId },
                ...(value === undefined ? {} : { value }),
              };
            }
          }
          const id = `resp-desktop-${++step}`;
          const item = name
            ? {
                type: "function_call",
                call_id: `call-desktop-${step}`,
                name,
                arguments: JSON.stringify(input),
              }
            : {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "合成订单已导入。" }],
              };
          const events = [
            { type: "response.created", sequence_number: 0, response: { id } },
            ...(!name
              ? [
                  {
                    type: "response.output_text.delta",
                    sequence_number: 1,
                    delta: "合成订单已导入。",
                  },
                ]
              : []),
            {
              type: "response.output_item.done",
              sequence_number: name ? 1 : 2,
              item,
            },
            {
              type: "response.completed",
              sequence_number: name ? 2 : 3,
              response: {
                id,
                status: "completed",
                output: [item],
                usage: {
                  input_tokens: 100,
                  output_tokens: 20,
                  total_tokens: 120,
                },
              },
            },
          ];
          response.writeHead(200, { "content-type": "text/event-stream" });
          for (const event of events)
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          `<!doctype html><html><body><h1>合成订单 · 产品链路验收</h1><label>日期<input type="text" value="2026-08"></label><label>渠道<select><option value="direct">直营</option><option value="partner">渠道</option></select></label><button onclick="document.querySelector('#result').textContent=document.querySelector('input').value+' / '+document.querySelector('select').value">筛选</button><p id="result"></p><a href="/export">下载订单</a></body></html>`,
        );
      } catch (error) {
        process.stderr.write(`${error}\n`);
        response
          .writeHead(500, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: String(error) } }));
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const root = resolve(".");
    const moduleDirectory = resolve("apps/crewon-ui/dist-electron");
    const owner = new BrowserWindow({ show: false });
    const recording = new RecordingHost({
      ownerWindow: owner,
      directory: join(data, "recordings"),
      moduleDirectory,
      rendererUrl: `${origin}/control`,
    });
    let bridge:
      | Awaited<ReturnType<typeof startDesktopBrowserExecution>>
      | undefined;
    const runtime = new RuntimeSupervisor({
      dataDirectory: join(data, "runtime"),
      paths: runtimePaths({
        packaged: false,
        repositoryRoot: root,
        resourcesPath: root,
      }),
      repositoryRoot: root,
      provider: () => ({
        providerId: "openai",
        endpoint: `${origin}/v1`,
        modelId: "fixture-browser-model",
        apiKey: "synthetic-fixture-key-at-least-32-bytes",
      }),
      providerModelCatalog: async () => ["fixture-browser-model"],
      workspaceRoot: () => null,
      browserExecution: () => bridge?.connection ?? null,
      revokeBrowserExecutions: () => bridge?.host.revokeAll(),
    });
    let success = false;
    try {
      bridge = await startDesktopBrowserExecution({
        sessions: recording,
        session: () => runtime.session(),
        dataDirectory: join(data, "browser"),
        moduleDirectory,
      });
      await runtime.start();
      process.stdout.write("Production Supervisor ready\n");
      await recording.open();
      const control = BrowserWindow.getAllWindows().find((w) => w !== owner)!;
      await control.webContents.executeJavaScript(
        `window.crewonRecording.navigate(${JSON.stringify(`${origin}/orders`)})`,
      );
      await control.webContents.executeJavaScript(
        "window.crewonRecording.bounds({x:0,y:0,width:1100,height:700})",
      );
      const session = recording.getExecutionSession();
      assert(session && session.mode === "idle");
      const makeClient = () => {
        const s = runtime.session();
        return new ControlApiClient({ ...s, accessToken: s.sessionToken });
      };
      let client = makeClient();
      const created = await client.createThread(
        { title: "F05真实浏览器链路（合成模型）" },
        "browser-e2e-thread",
      );
      const thread = created.thread;
      await bridge.host.authorize({ threadId: thread.threadId });
      const started = await client.startTurn(
        thread.threadId,
        {
          expectedRevision: thread.revision,
          agentVersionId: null,
          executionIntent: "none",
          toolPermissionMode: "fullAccess",
          content: "在已授权浏览器中筛选2026-09渠道订单，下载并导入任务文件。",
        },
        "browser-e2e-run",
      );
      const runId = started.run.runId;
      let run = (await client.getRun(runId)).run;
      const deadline = Date.now() + 90000;
      while (
        !["completed", "failed", "canceled"].includes(run.status) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 300));
        run = (await client.getRun(runId)).run;
      }
      assert.equal(run.status, "completed", JSON.stringify(run));
      assert.equal(downloads, 1);
      const pageState = await session.webContents.executeJavaScript(
        "({date:document.querySelector('input').value,channel:document.querySelector('select').value,result:document.querySelector('#result').textContent})",
      );
      assert.deepEqual(pageState, {
        date: "2026-09",
        channel: "partner",
        result: "2026-09 / partner",
      });
      let catalog = await client.delivery.catalog(thread.threadId);
      assert.equal(catalog.inputs.length, 1);
      const file = catalog.inputs[0]!;
      assert.equal(file.sourceRunId, runId);
      assert.equal(file.contentDigest, expectedDigest);
      assert.equal(
        Buffer.from(
          await client.delivery.download(
            thread.threadId,
            { kind: "input", id: file.inputId },
            file,
          ),
        ).toString(),
        csv,
      );
      writeFileSync(
        join(output, "desktop-run-orders.csv"),
        await client.delivery.download(
          thread.threadId,
          { kind: "input", id: file.inputId },
          file,
        ),
      );
      const image = await session.webContents.capturePage();
      writeFileSync(join(output, "desktop-run.png"), image.toPNG());
      await runtime.restart();
      client = makeClient();
      assert.equal(bridge.host.status(thread.threadId), null);
      catalog = await client.delivery.catalog(thread.threadId);
      assert.equal(catalog.inputs.length, 1);
      assert.equal(catalog.inputs[0]!.inputId, file.inputId);
      assert.equal(
        Buffer.from(
          await client.delivery.download(
            thread.threadId,
            { kind: "input", id: file.inputId },
            file,
          ),
        ).toString(),
        csv,
      );
      writeFileSync(
        join(output, "desktop-run.json"),
        JSON.stringify(
          {
            schemaVersion: "crewon.f05-desktop-run-evidence.v1",
            model: "scripted Responses SSE fixture",
            businessPage: "synthetic local HTTP fixture",
            runtime: "actual RuntimeSupervisor Control/Worker child processes",
            recordingHost: "actual F02 RecordingHost/WebContentsView",
            threadId: thread.threadId,
            runId,
            sessionId: session.sessionId,
            runStatus: run.status,
            modelRequests: requests.length,
            downloadRequests: downloads,
            pageState,
            file,
            restartedRead: true,
            grantRevokedOnRestart: true,
            notCovered: [
              "real model reasoning",
              "enterprise login",
              "scheduled Skill invocation",
            ],
          },
          null,
          2,
        ),
      );
      process.stdout.write(
        `PASS ${runId} ${file.inputId} ${file.contentDigest}\n`,
      );
      success = true;
    } finally {
      if (!success)
        writeFileSync(
          join(output, "desktop-run-failure.json"),
          JSON.stringify(
            {
              dataDirectory: data,
              modelRequests: requests,
              toolResults: results,
              step,
            },
            null,
            2,
          ),
        );
      await bridge?.close();
      await runtime.stop();
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  })
  .then(
    () => app.exit(0),
    (error) => {
      process.stderr.write(
        `${error instanceof Error ? error.stack : String(error)}\n`,
      );
      app.exit(1);
    },
  );
