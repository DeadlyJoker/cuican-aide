import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { ControlApiClient } from "../../../packages/control-client/src/index.ts";
import { setDesktopPluginSelectionWithNativeBusinessActivation } from "../../crewon-ui/electron/desktopNativePluginBusinessActivation.ts";
import { startDesktopInstalledPluginRuntimeChildren } from "../../crewon-ui/electron/desktopInstalledPluginRuntimeChildren.ts";
import { nativeLocalProcessFixture } from "./installed-plugin-native-process.integration.test-support.ts";

for (const variant of [
  { label: "source", runtimeDirectory: undefined },
  ...(process.env.CREWON_TEST_NATIVE_PACKAGED_RUNTIME_DIR === undefined
    ? []
    : [
        {
          label: "packaged",
          runtimeDirectory: process.env.CREWON_TEST_NATIVE_PACKAGED_RUNTIME_DIR,
        },
      ]),
])
  test(
    `${variant.label}: actual Native unmetered project generation reaches the real Worker beginRunAttempt transaction without model or supplier requests`,
    { timeout: 60000 },
    async (t) => {
      const diagnostics = await mkdtemp(
        join(await realpath(tmpdir()), "crewon-native-attempt-checkpoint-"),
      );
      const marker = join(diagnostics, "attempt.json");
      const identityDiagnostic = join(diagnostics, "identity.json");
      const contextEntry = pathToFileURL(
        fileURLToPath(
          new URL("./plugins/installed-plugin-run-context.ts", import.meta.url),
        ),
      ).href;
      const checkpoint = join(diagnostics, "checkpoint.mjs");
      const storeEntry = pathToFileURL(
        fileURLToPath(
          new URL("../../../packages/store/src/index.ts", import.meta.url),
        ),
      ).href;
      const applicationEntry = pathToFileURL(
        fileURLToPath(
          new URL(
            "../../../packages/application/src/index.ts",
            import.meta.url,
          ),
        ),
      ).href;
      await writeFile(
        checkpoint,
        `import crypto from 'node:crypto'; import {syncBuiltinESMExports} from 'node:module'; import {InstalledPluginRunContext} from ${JSON.stringify(contextEntry)}; import {writeFileSync} from 'node:fs'; import {SqliteRunStore} from ${JSON.stringify(storeEntry)}; import {PluginUiApplicationService,PluginUiCommittedTaskAuthority} from ${JSON.stringify(applicationEntry)};
${process.env.CREWON_TEST_NATIVE_FORCE_UNSAFE_IDS === "1" ? "const random=crypto.randomBytes;crypto.randomBytes=function(size,...rest){const bytes=Reflect.apply(random,this,[size,...rest]);const stack=new Error().stack;if(size===32&&(stack?.includes('/desktop-native-plugin-task-runtime.ts')||stack?.includes('/plugin-task-application-ids.ts')))bytes[0]=0xf8;return bytes;};syncBuiltinESMExports();" : ""}
const originalLoad=InstalledPluginRunContext.prototype.load;InstalledPluginRunContext.prototype.load=async function(...args){const result=await Reflect.apply(originalLoad,this,args);if(result){const c=result.context;const fields=[...Object.entries(c.scope).map(([k,v])=>['scope.'+k,v]),['run.runId',c.run.runId],['run.threadId',c.run.threadId],...(c.run.source===null?[]:Object.entries(c.run.source).filter(([k])=>k!=='bindingDigest').map(([k,v])=>['run.source.'+k,v]))];const invalid=fields.filter(([,v])=>typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(v)).map(([field,value])=>({field,value}));if(invalid.length)writeFileSync(${JSON.stringify(identityDiagnostic)},JSON.stringify(invalid),{mode:0o600});}return result;};
if(process.argv[1]?.endsWith('/runtime-worker.mjs')){const original=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin.startsWith('http://127.0.0.1:'))return original(input,init);writeFileSync(${JSON.stringify(marker)},JSON.stringify({blocked:true}),{mode:0o600});throw new Error('owned_native_generation_external_network_blocked');};}
const report=(operation,error)=>{const causes=[];for(let e=error;e&&causes.length<6;e=e.cause)causes.push({name:e.name,code:/^[a-z][a-z0-9_]+$/.test(e.message)?e.message:null,frames:e.stack?.split('\\n').slice(1,5)});process.stderr.write('OWNED_NATIVE_DIAGNOSTIC '+JSON.stringify({operation,causes})+'\\n');};
for(const [type,method] of [[PluginUiApplicationService,'invoke'],[PluginUiCommittedTaskAuthority,'issueProjectGeneration']]){const original=type.prototype[method];type.prototype[method]=function(...args){try{const result=Reflect.apply(original,this,args);if(result?.then)void result.catch(error=>report(method,error));return result;}catch(error){report(method,error);throw error;}};}
const original=SqliteRunStore.prototype.beginRunAttempt;
SqliteRunStore.prototype.beginRunAttempt=async function(...input){const result=await Reflect.apply(original,this,input);writeFileSync(${JSON.stringify(marker)},JSON.stringify({committed:true}),{mode:0o600});throw new Error('owned_native_generation_attempt_checkpoint');};`,
        { mode: 0o600 },
      );
      const sourceDirectory = process.env.CREWON_TEST_SHORT_DRAMA_PLUGIN_DIR;
      assert.ok(
        sourceDirectory,
        "the independent UI-only Short Drama package is required",
      );
      const f = await nativeLocalProcessFixture(t, {
        packagedRuntimeDirectory: variant.runtimeDirectory,
        projectSourceDirectory: sourceDirectory,
        diagnosticImport: checkpoint,
      });
      t.after(() => rm(diagnostics, { recursive: true, force: true }));
      await f.runRelease(f.owner.preparationEnvironment);
      const first = f.owner.complete();
      assert.equal(first.kind, "installed");
      if (first.kind !== "installed") return;
      await f.runRelease(first.runtime.release);
      const bridge = await f.prepareProjectBridge(
        first.runtime.expectedCatalogEntries[0]!,
      );
      await f.runRelease(bridge.preparationEnvironment);
      const prepared = bridge.complete();
      assert.equal(prepared.kind, "installed");
      if (prepared.kind !== "installed") return;
      await f.runRelease(prepared.runtime.release);
      const current = await startDesktopInstalledPluginRuntimeChildren({
        runtime: prepared.runtime,
        signal: new AbortController().signal,
        spawnWorker: (environment) => f.start("worker", environment),
        spawnControl: (environment) => f.start("control", environment),
        trackChild: () => {},
        deadlineMs: 20000,
      });
      await f.waitForControl(current.control);
      const client = new ControlApiClient({
        baseUrl: `http://127.0.0.1:${f.port}/`,
        accessToken: f.sessionToken,
        csrfToken: f.environment.CREWON_CONTROL_CSRF_TOKEN!,
        origin: f.environment.CREWON_CONTROL_ORIGIN!,
      });
      for (const plugin of [f.identity, f.projectSource!.identity])
        await setDesktopPluginSelectionWithNativeBusinessActivation({
          runtime: prepared.runtime,
          client,
          command: {
            pluginId: plugin.pluginId,
            request: {
              expectedSelectionRevision: 1,
              state: "enabled",
              selectedPackageDigest: plugin.packageDigest,
            },
            idempotencyKey: `native-attempt-enable-${plugin.pluginId}`,
          },
          signal: new AbortController().signal,
        });
      const post = async (path: string, input: object, key?: string) => {
        const response = await fetch(`http://127.0.0.1:${f.port}${path}`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: {
            "authorization": `Bearer ${f.sessionToken}`,
            "origin": f.environment.CREWON_CONTROL_ORIGIN!,
            "x-csrf-token": f.environment.CREWON_CONTROL_CSRF_TOKEN!,
            "content-type": "application/json",
            ...(key === undefined ? {} : { "idempotency-key": key }),
          },
          body: JSON.stringify(input),
        });
        const body = await response.text();
        assert.ok(
          response.ok,
          `${body}\n${f
            .logs(current.control)
            .stderr.split("\n")
            .filter((line) => line.startsWith("OWNED_NATIVE_DIAGNOSTIC"))
            .join("\n")}`,
        );
        return JSON.parse(body);
      };
      const thread = (
        await post(
          "/api/v1/threads",
          {
            title: "Native unmetered Worker admission regression",
            workspaceId: f.firstWorkspace.workspaceId,
          },
          "native-attempt-thread",
        )
      ).thread;
      const lease = await post("/api/v1/plugins/ui/mounts", {
        pluginId: f.projectSource!.identity.pluginId,
        contributionId: "workbench",
        expectedSelectionRevision: 2,
        expectedPackageDigest: f.projectSource!.identity.packageDigest,
      });
      const invoke = async (action: string, input: object) =>
        (
          await post(`/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`, {
            action,
            input,
          })
        ).output;
      const project = await invoke(
        "crewon.creative-projects.v1.createProject",
        {
          request: {
            title: "Native admission",
            briefText: "Real unmetered admission only",
          },
          idempotencyKey: "native-attempt-project",
        },
      );
      const concept = await invoke(
        "crewon.creative-projects.v1.createConcept",
        {
          projectId: project.project.projectId,
          request: {
            briefRevision: project.brief.briefRevision,
            name: "Saved input",
            prompt: "A quiet garden in morning light",
            expectedProjectRevision: project.project.revision,
          },
          idempotencyKey: "native-attempt-concept",
        },
      );
      const reference = {
        projectId: project.project.projectId,
        assetId: concept.asset.assetId,
        assetRevision: concept.assetRevision.assetRevision,
        expectedProjectRevision: concept.project.revision,
        expectedAssetMetadataRevision: concept.asset.revision,
      };
      const generationRequest = {
        action: "crewon.project-generations.v1.generateConcept" as const,
        input: {
          reference,
          threadId: thread.threadId,
          expectedThreadRevision: thread.revision,
          idempotencyKey: "native-attempt-original-generation",
        },
      };
      const staged = await client.plugins.stageRecovery(
        lease.mountRef,
        generationRequest,
      );
      assert.equal(staged.intent.phase, "prepared");
      const receipt = await invoke(
        generationRequest.action,
        generationRequest.input,
      );
      assert.ok(receipt);
      const db = new DatabaseSync(f.databasePath, { readOnly: true });
      try {
        const deadline = Date.now() + 10000;
        let last: unknown;
        for (;;) {
          last = db
            .prepare(
              "SELECT status,attempt_count,last_error_code FROM work_items WHERE work_item_order=(SELECT max(work_item_order) FROM work_items)",
            )
            .get();
          try {
            assert.deepEqual(
              JSON.parse(await readFile(marker, "utf8")),
              variant.runtimeDirectory === undefined
                ? {
                    committed: true,
                  }
                : { blocked: true },
            );
            break;
          } catch (error) {
            if (Date.now() >= deadline)
              assert.fail(
                `real beginRunAttempt not reached: ${JSON.stringify(last)}; identity fields: ${await readFile(identityDiagnostic, "utf8").catch(() => "none")}`,
              );
            await delay(50);
          }
        }
        assert.equal(
          db
            .prepare(
              "SELECT count(*) AS n FROM plugin_task_unmetered_admissions",
            )
            .get()!.n,
          1,
        );
        assert.equal(
          db
            .prepare(
              "SELECT count(*) AS n FROM creative_project_generation_links",
            )
            .get()!.n,
          1,
        );
        assert.equal(
          db.prepare("SELECT count(*) AS n FROM run_snapshots").get()!.n,
          1,
        );
        assert.equal(
          db.prepare("SELECT count(*) AS n FROM run_attempts").get()!.n,
          1,
        );
        assert.equal(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE name='plugin_credit_accounts'",
            )
            .get(),
          undefined,
          "genuine Native unmetered admission must not create a credit account schema",
        );
        assert.equal(
          db
            .prepare("SELECT count(*) AS n FROM extension_external_operations")
            .get()!.n,
          0,
        );
        assert.ok(
          (await f.audit()).every((row) =>
            row.origin.startsWith("http://127.0.0.1:"),
          ),
        );
        assert.equal(current.worker.exitCode, null);
        assert.equal(current.control.exitCode, null);
      } finally {
        db.close();
      }
    },
  );
