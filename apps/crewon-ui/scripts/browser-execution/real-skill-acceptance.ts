import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { ControlApiClient } from "@crewon/control-client";
import { RecordingHost } from "../../electron/recordingHost.ts";
import {
  RuntimeSupervisor,
  runtimePaths,
} from "../../electron/runtimeSupervisor.ts";
import { startDesktopBrowserExecution } from "../../electron/browserExecutionDesktop.ts";
import type { BrowserGrantRule } from "../../src/lib/browser-execution/browserExecutionGrant.ts";

// Manual integration acceptance: read only the explicitly authorized credential
// file. Persisted outputs contain reviewed synthetic business data, never secrets.
const envFile = process.argv[2];
assert(envFile, "An explicitly authorized provider env path is required");
process.loadEnvFile(resolve(envFile));
const apiKey = process.env.AICUICAN_API_KEY?.trim();
assert(apiKey, "Authorized provider credential unavailable");
process.env.CREWON_RESPONSES_STREAM_MAX_RETRIES = "0";
const output = resolve(
  process.env.CREWON_F05_EVIDENCE_DIR ?? "artifacts/f05-real-skill",
);
mkdirSync(output, { recursive: true });
const reuse = process.env.CREWON_F05_REUSE_DATA_DIRECTORY;
const data = reuse
  ? resolve(reuse)
  : mkdtempSync(join(tmpdir(), "crewon-f05-real-skill-"));
app.setPath("userData", data);
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const write = (name: string, value: unknown) =>
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n");
const reviewFile = "reviewed-delivery-method.json";
const versionFile = "delivery-version.json";
const expectedAssembly = (templateInputId: string, inputId: string) => ({
  name: "second-period-orders.xlsx",
  templateInputId,
  sources: [{ inputId, sheet: "CSV", headerRow: 1 }],
  targetSheet: "明细",
  startRow: 2,
  columns: ["order_id", "channel", "currency", "amount", "status"].map(
    (sourceHeader, index) => ({
      sourceHeader,
      targetColumn: String.fromCharCode(65 + index),
    }),
  ),
  rules: {
    exclude: [
      { header: "status", equals: "canceled" },
      { header: "channel", equals: "partner" },
      { header: "currency", equals: "USD" },
    ],
    requiredHeaders: ["amount"],
    exceptionSheet: "异常",
    lineageSheet: "来源",
    summary: {
      sheet: "汇总",
      startRow: 2,
      groupBy: ["channel", "currency"],
      valueHeader: "amount",
    },
  },
});
let stopRequested = false;
process.on("SIGTERM", () => {
  stopRequested = true;
});
process.on("SIGINT", () => {
  stopRequested = true;
});
app
  .whenReady()
  .then(async () => {
    const root = resolve(".");
    const moduleDirectory = resolve("apps/crewon-ui/dist-electron");
    const sourceDir = resolve(
      "artifacts/f05-browser-execution/recorded-source",
    );
    const recordingExport = JSON.parse(
      readFileSync(join(sourceDir, "recording-export.json"), "utf8"),
    );
    const origin = recordingExport.authorization.allowedOrigins[0];
    assert(new URL(origin).hostname === "127.0.0.1");
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
        providerId: "aicuican",
        endpoint: "https://api.aicuican.com/v1",
        modelId: "gpt-5.5",
        apiKey,
      }),
      providerModelCatalog: async () => ["gpt-5.5"],
      workspaceRoot: () => null,
      browserExecution: () => bridge?.connection ?? null,
      revokeBrowserExecutions: () => bridge?.host.revokeAll(),
    });
    let client: ControlApiClient;
    let trialTemplate: { inputId: string } | undefined;
    const request = async (
      path: string,
      body?: unknown,
      method = "POST",
      key?: string,
    ) => {
      const s = runtime.session();
      const response = await fetch(new URL(path, s.baseUrl), {
        method: body === undefined ? "GET" : method,
        headers: {
          "authorization": `Bearer ${s.sessionToken}`,
          "x-csrf-token": s.csrfToken,
          "origin": s.origin,
          "content-type": "application/json",
          ...(key ? { "idempotency-key": key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      assert(
        response.ok,
        `${path} ${response.status}: ${JSON.stringify(result)}`,
      );
      return result;
    };
    const waitRun = async (runId: string) => {
      let run = (await client.getRun(runId)).run;
      const deadline = Date.now() + 900000;
      while (
        !["completed", "failed", "canceled", "needsHuman"].includes(
          run.status,
        ) &&
        Date.now() < deadline
      ) {
        await pause(1000);
        run = (await client.getRun(runId)).run;
        write("progress.json", {
          runId,
          status: run.status,
          revision: run.revision,
          waitingApproval: run.waitingApproval,
          dataDirectory: data,
        });
        if (stopRequested) {
          write(`stopped-run-${runId}.json`, run);
          await client.cancelRun(
            runId,
            { expectedRevision: run.revision },
            `acceptance-stop-${runId}`,
          );
          throw new Error(
            `Acceptance stopped and Run cancellation requested: ${runId}`,
          );
        }
        if (run.waitingApproval) {
          // The user delegated this exact file operation. Review the concrete
          // model request against actual saved inputs, then use normal approval.
          assert(trialTemplate, "Generation must never request tool approval");
          const { approval } = await client.getToolApproval(
            run.waitingApproval.approvalId,
          );
          assert.equal(approval.runId, runId);
          const database = new DatabaseSync(
            join(data, "runtime/control.sqlite"),
            { readOnly: true },
          );
          const row = database
            .prepare(
              "SELECT r.state_json FROM tool_execution_receipts r JOIN tool_approvals a ON a.receipt_id = r.receipt_id WHERE a.approval_id = ? AND r.run_id = ?",
            )
            .get(approval.approvalId, runId);
          assert(row);
          const receipt = JSON.parse(String(row.state_json));
          const call = database
            .prepare(
              "SELECT item_json FROM model_history_items WHERE run_id = ? ORDER BY sequence",
            )
            .all(runId)
            .map((r) => JSON.parse(String(r.item_json)))
            .find(
              (item) =>
                item.type === "tool_call" &&
                item.callId === receipt.call.callId,
            );
          database.close();
          assert.equal(call?.name, "delivery_assemble");
          const catalog = await client.delivery.catalog(run.threadId);
          const sources = catalog.inputs.filter(
            (input) => input.sourceRunId === runId,
          );
          assert.equal(sources.length, 1);
          const modelInput = JSON.parse(call.input);
          assert.deepEqual(
            modelInput,
            expectedAssembly(trialTemplate.inputId, sources[0]!.inputId),
          );
          write(`reviewed-approval-${approval.approvalId}.json`, {
            approval,
            modelInput,
            source: sources[0],
            reviewer:
              "Codex delegated concrete-request review; no blanket fullAccess",
          });
          await client.decideToolApproval(
            approval.approvalId,
            {
              expectedRevision: approval.revision,
              decision: "approved",
              comment:
                "代理按既有明确授权审阅实际模板、下载输入、映射与规则后批准此单次文件生成。",
            },
            `reviewed-assemble-${approval.approvalId}`,
          );
        }
      }
      assert.equal(run.status, "completed", JSON.stringify(run));
      return run;
    };
    try {
      bridge = await startDesktopBrowserExecution({
        sessions: recording,
        session: () => runtime.session(),
        dataDirectory: join(data, "browser"),
        moduleDirectory,
      });
      await runtime.start();
      const s = runtime.session();
      client = new ControlApiClient({ ...s, accessToken: s.sessionToken });
      const evidence = recordingExport.evidence.map((e: any) => ({
        evidenceId: e.evidenceId,
        mediaType: e.mediaType,
        dataBase64: readFileSync(
          join(
            sourceDir,
            "evidence",
            `${e.evidenceId}.${e.mediaType === "image/png" ? "png" : "svg"}`,
          ),
        ).toString("base64"),
      }));
      const skill = await request(
        "/api/v1/skills",
        { recording: recordingExport, evidence },
        "POST",
        "f05-source-import",
      );
      assert.equal(skill.source.provenance, "recording");
      let generationRun: any;
      let reviewed: any;
      let version: any;
      if (reuse) {
        const prior = JSON.parse(
          readFileSync(join(output, "candidate.json"), "utf8"),
        );
        assert.deepEqual(prior.source, skill.source);
        const collected = await request(
          `/api/v1/skills/${skill.skillId}/generations/${prior.generationId}`,
        );
        assert.equal(collected.verification, "real");
        generationRun = (await client.getRun(collected.runId)).run;
        assert.equal(generationRun.status, "completed");
        reviewed = JSON.parse(readFileSync(join(output, reviewFile), "utf8"));
        assert.equal(reviewed.generationId, prior.generationId);
        if (existsSync(join(output, versionFile))) {
          const saved = JSON.parse(
            readFileSync(join(output, versionFile), "utf8"),
          );
          version = (
            await request(
              `/api/v1/skills/${skill.skillId}/versions/${saved.ref.versionId}?contentDigest=${encodeURIComponent(saved.ref.contentDigest)}`,
            )
          ).version;
        } else {
          const current = await request(`/api/v1/skills/${skill.skillId}`);
          const edited = await request(
            `/api/v1/skills/${skill.skillId}`,
            {
              expectedRevision: current.skill.revision,
              method: reviewed.method,
            },
            "PATCH",
          );
          version = await request(`/api/v1/skills/${skill.skillId}/versions`, {
            expectedRevision: edited.revision,
          });
          write(versionFile, version);
        }
        assert.deepEqual(version.method, reviewed.method);
        const oldExecution = JSON.parse(
          readFileSync(join(output, "execution.json"), "utf8"),
        );
        const oldRun = (await client.getRun(oldExecution.execution.runId)).run;
        write(`previous-trial-run-${oldRun.runId}.json`, oldRun);
        if (!["completed", "failed", "canceled"].includes(oldRun.status))
          await client.cancelRun(
            oldRun.runId,
            { expectedRevision: oldRun.revision },
            `cancel-initial-${oldRun.runId}`,
          );
      } else {
        const { thread } = await client.createThread(
          { title: "实际录制来源 · 模型方法生成" },
          "f05-generation-thread",
        );
        const generationId = `generation-${randomUUID()}`;
        const generation = await request(
          `/api/v1/skills/${skill.skillId}/generations`,
          {
            generationId,
            threadId: thread.threadId,
            expectedThreadRevision: thread.revision,
            agentVersionId: null,
            expectedSkillRevision: skill.revision,
          },
        );
        process.stdout.write(`REAL_GENERATION ${generation.runId}\n`);
        generationRun = await waitRun(generation.runId);
        const collected = await request(
          `/api/v1/skills/${skill.skillId}/generations/${generationId}/collect`,
          {},
        );
        assert.equal(collected.verification, "real");
        assert.equal(collected.outcome, "candidate");
        write("candidate.json", {
          generationId,
          skillId: skill.skillId,
          source: skill.source,
          generation: collected,
        });
        write("progress.json", {
          phase: "awaiting-agent-review",
          generationId,
          skillId: skill.skillId,
          dataDirectory: data,
        });
        process.stdout.write(`REVIEW_READY ${generationId}\n`);
        const reviewDeadline = Date.now() + 600000;
        while (Date.now() < reviewDeadline) {
          if (existsSync(join(output, reviewFile))) {
            const proposed = JSON.parse(
              readFileSync(join(output, reviewFile), "utf8"),
            );
            if (proposed.generationId === generationId) {
              reviewed = proposed;
              break;
            }
          }
          await pause(500);
        }
        assert(reviewed, "Reviewed method not supplied for this generation");
        const applied = await request(
          `/api/v1/skills/${skill.skillId}/generations/${generationId}/apply`,
          { expectedSkillRevision: skill.revision },
        );
        const edited = await request(
          `/api/v1/skills/${skill.skillId}`,
          {
            expectedRevision: applied.appliedRevision,
            method: reviewed.method,
          },
          "PATCH",
        );
        version = await request(`/api/v1/skills/${skill.skillId}/versions`, {
          expectedRevision: edited.revision,
        });
        write(versionFile, version);
      }
      const { thread: trial } = await client.createThread(
        { title: "实际录制方法 · 第二期订单试跑" },
        `f05-trial-thread-${randomUUID()}`,
      );
      trialTemplate = await client.delivery.upload(
        trial.threadId,
        {
          name: "orders-template.xlsx",
          role: "template",
          mediaType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          contentBase64: readFileSync(
            resolve("docs/sdd/F01-delivery/fixtures/orders-template.xlsx"),
          ).toString("base64"),
        },
        `template-${trial.threadId}`,
      );
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
      const grant = await bridge.host.authorize({
        threadId: trial.threadId,
        scope: {
          skillVersionRef: version.ref,
          origins: [origin],
          rules: reviewed.browserRules as BrowserGrantRule[],
        },
      });
      const catalog = await client.delivery.catalog(trial.threadId);
      const invocation = {
        schemaVersion: "crewon.skill-invocation.v1",
        skill: version.ref,
        parameters: reviewed.parameters,
        requiredToolRefs: version.method.requiredToolRefs,
        deliveryTarget: catalog.target,
      };
      const executionId = `trial-${randomUUID()}`;
      const execution = await request(
        `/api/v1/skills/${skill.skillId}/executions`,
        {
          executionId,
          threadId: trial.threadId,
          expectedThreadRevision: trial.revision,
          agentVersionId: null,
          purpose: "trial",
          invocation,
        },
      );
      write("execution.json", {
        execution,
        invocation,
        grant,
        reviewer: "Codex delegated acceptance, not a claimed human click",
      });
      process.stdout.write(`REAL_TRIAL ${execution.runId}\n`);
      const trialRun = await waitRun(execution.runId);
      const finalCatalog = await client.delivery.catalog(trial.threadId);
      assert.equal(finalCatalog.inputs.length, 2);
      const file = finalCatalog.inputs.find(
        (input) => input.sourceRunId === execution.runId,
      )!;
      assert(file);
      assert.equal(file.sourceRunId, execution.runId);
      const bytes = await client.delivery.download(
        trial.threadId,
        { kind: "input", id: file.inputId },
        file,
      );
      const csv = Buffer.from(bytes).toString("utf8");
      assert(
        csv.includes("A101") && csv.includes("A103"),
        "Must download actual second-period material",
      );
      writeFileSync(join(output, "orders-second-period.csv"), bytes);
      const delivered = finalCatalog.deliveries.filter(
        (item) => item.sourceRunId === execution.runId,
      );
      assert.equal(
        delivered.length,
        1,
        "The actual model Run must save its own XLSX",
      );
      const deliveryVersion = delivered[0]!;
      assert.deepEqual(
        [...deliveryVersion.inputIds].sort(),
        [trialTemplate.inputId, file.inputId].sort(),
      );
      const workbookBytes = await client.delivery.download(
        trial.threadId,
        { kind: "version", id: deliveryVersion.versionId },
        deliveryVersion,
      );
      const xlsx = createRequire(resolve("apps/crewon-ui/package.json"))(
        "xlsx",
      );
      const workbook = xlsx.read(Buffer.from(workbookBytes), {
        type: "buffer",
      });
      assert.equal(workbook.Sheets["汇总"].A2.v, "direct");
      assert.equal(workbook.Sheets["汇总"].B2.v, "CNY");
      assert.equal(workbook.Sheets["汇总"].C2.v, 200);
      assert.equal(deliveryVersion.validation.writtenRows, 2);
      writeFileSync(join(output, "second-period-orders.xlsx"), workbookBytes);
      const pageState = await session.webContents.executeJavaScript(
        "({date:document.querySelector('#date').value,channel:document.querySelector('#channel').value,result:document.querySelector('#result').textContent})",
      );
      assert.equal(pageState.date, reviewed.parameters.date);
      assert.equal(pageState.channel, reviewed.parameters.channel);
      writeFileSync(
        join(output, "real-trial.png"),
        (await session.webContents.capturePage()).toPNG(),
      );
      const review = await request(
        `/api/v1/skills/${skill.skillId}/executions/${executionId}/review`,
        {
          criteria: version.method.completionCriteria,
          coverage: ["new-date", "new-input"],
          resultNote:
            "Codex代理验收：真实模型、实际F02来源、第二期页面值及CSV字节独立校验；非人工GUI验收。",
        },
      );
      await runtime.restart();
      const rs = runtime.session();
      client = new ControlApiClient({ ...rs, accessToken: rs.sessionToken });
      assert.equal(bridge.host.status(trial.threadId), null);
      assert.equal(
        Buffer.from(
          await client.delivery.download(
            trial.threadId,
            { kind: "input", id: file.inputId },
            file,
          ),
        ).toString(),
        csv,
      );
      assert.deepEqual(
        await client.delivery.download(
          trial.threadId,
          { kind: "version", id: deliveryVersion.versionId },
          deliveryVersion,
        ),
        workbookBytes,
      );
      const detail = await request(`/api/v1/skills/${skill.skillId}`);
      const database = new DatabaseSync(join(data, "runtime/control.sqlite"), {
        readOnly: true,
      });
      const generationToolReceipts = database
        .prepare(
          "SELECT count(*) AS count FROM tool_execution_receipts WHERE run_id = ?",
        )
        .get(generationRun.runId)!.count;
      assert.equal(generationToolReceipts, 0);
      const toolReceipts = database
        .prepare(
          "SELECT state_json FROM tool_execution_receipts WHERE run_id = ? ORDER BY prepared_at",
        )
        .all(trialRun.runId)
        .map((row) => {
          const receipt = JSON.parse(String(row.state_json));
          return {
            executionId: receipt.executionId,
            name: receipt.call.name,
            status: receipt.status,
            actionDigest: receipt.actionDigest,
          };
        });
      const modelCalls = database
        .prepare(
          "SELECT record_json FROM model_call_observations WHERE run_id = ? ORDER BY call_order",
        )
        .all(trialRun.runId)
        .map((row) => {
          const record = JSON.parse(String(row.record_json));
          return {
            callId: record.observation.callId,
            adapterName: record.observation.adapterName,
            transport: record.observation.transport,
            outcome: record.observation.outcome,
          };
        });
      assert(
        toolReceipts.some(
          (receipt) =>
            receipt.name === "delivery_assemble" &&
            receipt.status === "completed",
        ),
      );
      const modelHistory = database
        .prepare(
          "SELECT item_json FROM model_history_items WHERE run_id = ? ORDER BY sequence",
        )
        .all(trialRun.runId)
        .map((row) => JSON.parse(String(row.item_json)));
      database.close();
      write("model-history.json", modelHistory);
      write("result.json", {
        checkedAt: new Date().toISOString(),
        provider: "https://api.aicuican.com/v1",
        model: "gpt-5.5",
        source: skill.source,
        generationRun,
        generationToolReceipts,
        trialRun,
        toolReceipts,
        modelCalls,
        version: version.ref,
        executionId,
        parameters: reviewed.parameters,
        pageState,
        file,
        deliveryVersion,
        deliveryVerification: {
          assembly:
            "actual model delivery_assemble call in the same Run using its browser-imported CSV",
          independentReader: "SheetJS",
          directCny: 200,
          writtenRows: 2,
          restartedBytesIdentical: true,
        },
        review,
        restartedRead: true,
        grantRevokedOnRestart: true,
        skillReviewAfterRestart: detail.executions,
        limitations: [
          "synthetic business material",
          "agent-reviewed, not human/CUA GUI",
          "no enterprise login",
          "no scheduled occurrence tested in this script",
        ],
      });
      process.stdout.write(
        `REAL_TRIAL_PASS ${execution.runId} ${file.inputId}\n`,
      );
    } finally {
      await bridge?.close();
      await runtime.stop();
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
    }
  })
  .then(
    () => app.exit(0),
    (error) => {
      process.stderr.write(
        `${String(error instanceof Error ? error.stack : error).replaceAll(apiKey, "[redacted]")}\n`,
      );
      app.exit(1);
    },
  );
