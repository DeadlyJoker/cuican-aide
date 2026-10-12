import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { writeFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DESKTOP_RUNTIME_OWNER as actor } from "../../crewon-ui/electron/desktopExtensionRuntime.ts";
import {
  nativeProjectWorkspaceBridgeFixture,
  waitMessage,
} from "../../crewon-ui/electron/desktopNativeProjectWorkspaceBridge.test-support.ts";
import { conversationPackage } from "./project-conversation-package.test-support.ts";

const profileId = "00000000-0000-4000-8000-000000000001";
const standaloneUrl = new URL("./standalone-composition.ts", import.meta.url)
  .href;
const startupUrl = new URL("./desktop-project-startup.ts", import.meta.url)
  .href;
const configUrl = new URL("./desktop-plugin-configuration.ts", import.meta.url)
  .href;
const clientUrl = new URL(
  "./desktop-native-project-workspace-client.ts",
  import.meta.url,
).href;
const artifactUrl = new URL(
  "../../../packages/artifacts/src/index.ts",
  import.meta.url,
).href;
const program = `
const {createStandaloneControlApiWithPlugins}=await import(${JSON.stringify(standaloneUrl)});
const {composeDesktopProjectStartup}=await import(${JSON.stringify(startupUrl)});
const {parseDesktopPluginConfiguration}=await import(${JSON.stringify(configUrl)});
const {DesktopNativeProjectWorkspaceClient}=await import(${JSON.stringify(clientUrl)});
const {InMemoryArtifactStore}=await import(${JSON.stringify(artifactUrl)});
let runtime;let client;
process.on('message',async message=>{
 if(message?.kind==='fixture.configure'){
  try {
   const configuration=parseDesktopPluginConfiguration(message.configuration);
   client=new DesktopNativeProjectWorkspaceClient({signal:new AbortController().signal});
   runtime=await createStandaloneControlApiWithPlugins({
    databasePath:message.databasePath,desktopWorkspaceRegistryPath:message.registryPath,
    actor:configuration.actor,defaultAgentVersionId:'no-model',sessionToken:'s'.repeat(32),csrfToken:'c'.repeat(32),
    allowedOrigins:['crewon://desktop'],artifactStore:new InMemoryArtifactStore(),artifactEncryptionKeyId:'fixture-key',
    heartbeatIntervalMs:null,outboxScanIntervalMs:null,outboxRetention:null,artifactRetention:null,automationScanIntervalMs:null,
    desktopPlugins:configuration,...composeDesktopProjectStartup({configuration,actor:configuration.actor}),
    desktopNativeProjectWorkspaceObserver:preparation=>client.observePreparedProject(preparation),
   });
   const origin=await runtime.app.listen({host:'127.0.0.1',port:0});
   process.send({kind:'fixture.listening',origin});
  }catch(error){process.send({kind:'fixture.listening',error:error.code??error.message});}
 }else if(message?.kind==='fixture.close'){
   await runtime?.app.close();await client?.close();process.send({kind:'fixture.cleaned'});
 }
});
process.send({kind:'fixture.ready'});
`;

// Real installed bytes, HTTP, source UI qualification, Main IPC, original allocator/registry and original Thread.
// Actor, bootstrap approvals and standalone policies are named test configuration; no real user Web/Agent claim.
test(
  "installed HTTP project reaches its actual Native directory and original admitted Thread without seeded ownership or namespace",
  { timeout: 30000 },
  async (t) => {
    let native:
      | Awaited<ReturnType<typeof nativeProjectWorkspaceBridgeFixture>>
      | undefined;
    const { source, pkg, publications } = await conversationPackage(t, {
      workspaceTargetProtocol: "1",
      beforeCleanup: async () => {
        if (!native) return;
        try {
          const cleaned = waitMessage(
            native.control,
            (m) => m.kind === "fixture.cleaned",
          );
          native.control.send({ kind: "fixture.close" });
          await cleaned;
        } finally {
          await native.close();
          native = undefined;
        }
      },
    });
    native = await nativeProjectWorkspaceBridgeFixture("none", program, {
      beforeBootstrap(f) {
        Object.assign(f.source, {
          sourceId: pkg.sourceId,
          directory: pkg.directory,
          pluginId: pkg.pluginId,
          publisherId: pkg.publisherId,
          version: pkg.version,
          packageDigest: pkg.packageDigest,
        });
        Object.assign(f.publication, {
          pluginId: pkg.pluginId,
          publisherId: pkg.publisherId,
          packageDigest: pkg.packageDigest,
          publicAssets: ["ui.mjs"],
        });
        writeFileSync(
          join(f.dataDirectory, "plugin-profile.json"),
          JSON.stringify({
            schemaVersion: "crewon.desktop-plugin-profile.v1",
            actor,
            scope: {
              tenantId: actor.tenantId,
              spaceId: actor.spaceId,
              profileId,
            },
          }),
          { mode: 0o600 },
        );
      },
    });
    const f = native;
    f.bridge();
    const configured = waitMessage(
      f.control,
      (m) => m.kind === "fixture.listening",
    );
    f.control.send({
      kind: "fixture.configure",
      databasePath: join(f.dataDirectory, "control.sqlite"),
      registryPath: join(f.dataDirectory, "desktop-workspace.json"),
      configuration: {
        schemaVersion: "crewon.desktop-plugin-bootstrap.v2",
        actor,
        scope: { tenantId: actor.tenantId, spaceId: actor.spaceId, profileId },
        authorityEpoch: "native-http-project-test-epoch-0001",
        installRoot: source.installRoot,
        sources: [(({ descriptor: _d, ...p }) => p)(pkg)],
        publications: [
          {
            pluginId: pkg.pluginId,
            publisherId: pkg.publisherId,
            packageDigest: pkg.packageDigest,
            publicAssets: ["ui.mjs"],
          },
        ],
        projects: {
          version: "crewon.desktop-project-history.v1",
          pluginUi: { publications, creationOwnership: "plugin-project-v1" },
          textArtifacts: { version: "crewon.project-text.v1" },
          conversations: {
            publications,
            projectOwnership: "plugin-project-v1",
          },
        },
      },
    });
    const started = await configured;
    assert.equal(started.error, undefined);
    async function request(
      method: string,
      path: string,
      body?: object,
      key?: string,
    ) {
      const response = await fetch(started.origin + path, {
        method,
        headers: {
          "authorization": `Bearer ${"s".repeat(32)}`,
          "x-csrf-token": "c".repeat(32),
          "origin": "crewon://desktop",
          ...(body ? { "content-type": "application/json" } : {}),
          ...(key ? { "idempotency-key": key } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(5000),
      });
      const output = await response.json();
      assert.equal(response.status, 200, JSON.stringify(output));
      return output;
    }
    const installed = await request(
      "POST",
      "/api/v1/plugins/installations",
      {
        sourceId: pkg.sourceId,
        expectedPluginId: pkg.pluginId,
        expectedPackageDigest: pkg.packageDigest,
        expectedSelectionRevision: null,
      },
      "native-http-install",
    );
    assert.equal(installed.selection.state, "disabled");
    await request(
      "PUT",
      `/api/v1/plugins/selections/${pkg.pluginId}`,
      {
        expectedSelectionRevision: 1,
        state: "enabled",
        selectedPackageDigest: pkg.packageDigest,
      },
      "native-http-enable",
    );
    const lease = await request("POST", "/api/v1/plugins/ui/mounts", {
      pluginId: pkg.pluginId,
      contributionId: "workbench",
      expectedSelectionRevision: 2,
      expectedPackageDigest: pkg.packageDigest,
    });
    const invoke = async (action: string, input: object) =>
      (
        await request(
          "POST",
          `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
          { action, input },
        )
      ).output;
    const created = await invoke("crewon.creative-projects.v1.createProject", {
      request: {
        title: "原管理链路 Native HTTP 验收",
        briefText: "安装后的真实项目创建",
      },
      idempotencyKey: "native-http-project",
    });
    const projectId = created.project.projectId;
    const target = await invoke(
      "crewon.project-workspace-target.v1.resolveTarget",
      { projectId },
    );
    assert.equal(
      f.workspaces.status().workspaces.length,
      1,
      "read-only discovery does not allocate",
    );
    const input = {
      projectId,
      workspaceId: target.workspaceId,
      title: "原工作空间会话",
      idempotencyKey: "native-http-conversation",
    };
    const conversation = await invoke(
      "crewon.project-conversations.v1.createConversation",
      input,
    );
    assert.equal(conversation.disposition, "committed");
    assert.equal(conversation.binding.workspaceId, target.workspaceId);
    const entries = f.workspaces.status().workspaces;
    assert.equal(entries.length, 2);
    assert.equal(f.workspaces.root(), f.ordinary);
    const entry = entries.find((e) => e.workspaceId === target.workspaceId)!;
    assert.ok(entry);
    assert.ok(statSync(f.workspaces.root(target.workspaceId)).isDirectory());
    const replay = await invoke(
      "crewon.project-conversations.v1.createConversation",
      input,
    );
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.binding.threadId, conversation.binding.threadId);
    assert.equal(f.workspaces.status().workspaces.length, 2);
    const thread = await request(
      "GET",
      `/api/v1/threads/${conversation.binding.threadId}`,
    );
    assert.equal(thread.thread.workspaceId, target.workspaceId);
    const secondProject = await invoke(
      "crewon.creative-projects.v1.createProject",
      {
        request: { title: "第二个独立项目", briefText: "不共享第一个项目目录" },
        idempotencyKey: "native-http-project-two",
      },
    );
    const secondTarget = await invoke(
      "crewon.project-workspace-target.v1.resolveTarget",
      { projectId: secondProject.project.projectId },
    );
    assert.notEqual(secondTarget.workspaceId, target.workspaceId);
    const wrongTarget = await fetch(
      started.origin + `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      {
        method: "POST",
        headers: {
          "authorization": `Bearer ${"s".repeat(32)}`,
          "x-csrf-token": "c".repeat(32),
          "origin": "crewon://desktop",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "crewon.project-conversations.v1.createConversation",
          input: {
            ...input,
            projectId: secondTarget.projectId,
            idempotencyKey: "native-http-wrong-target",
          },
        }),
        signal: AbortSignal.timeout(5000),
      },
    );
    assert.equal(wrongTarget.status, 403);
    assert.equal(
      f.workspaces.status().workspaces.length,
      2,
      "wrong project target fails before allocation",
    );
    const secondConversation = await invoke(
      "crewon.project-conversations.v1.createConversation",
      {
        ...input,
        projectId: secondTarget.projectId,
        workspaceId: secondTarget.workspaceId,
        idempotencyKey: "native-http-conversation-two",
      },
    );
    assert.notEqual(
      secondConversation.binding.threadId,
      conversation.binding.threadId,
    );
    assert.notEqual(
      f.workspaces.root(secondTarget.workspaceId),
      f.workspaces.root(target.workspaceId),
    );
    assert.ok(
      statSync(f.workspaces.root(secondTarget.workspaceId)).isDirectory(),
    );
    assert.equal(f.workspaces.root(), f.ordinary);
    assert.equal(f.workspaces.status().workspaces.length, 3);
    const ordinaryBorrow = await fetch(started.origin + "/api/v1/threads", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${"s".repeat(32)}`,
        "x-csrf-token": "c".repeat(32),
        "origin": "crewon://desktop",
        "content-type": "application/json",
        "idempotency-key": "ordinary-must-not-borrow-plugin-workspace",
      },
      body: JSON.stringify({
        title: "普通入口不可借用插件目录",
        workspaceId: target.workspaceId,
      }),
      signal: AbortSignal.timeout(5000),
    });
    assert.notEqual(
      ordinaryBorrow.status,
      200,
      "ordinary Thread API cannot adopt a protected plugin workspace",
    );
    const db = new DatabaseSync(join(f.dataDirectory, "control.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        db
          .prepare("SELECT COUNT(*) n FROM plugin_project_metadata_owners")
          .get()!.n,
        2,
      );
      assert.equal(
        db
          .prepare("SELECT COUNT(*) n FROM plugin_project_workspace_namespaces")
          .get()!.n,
        2,
      );
      assert.equal(db.prepare("SELECT COUNT(*) n FROM threads").get()!.n, 2);
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM run_snapshots").get()!.n,
        0,
      );
    } finally {
      db.close();
    }
  },
);
