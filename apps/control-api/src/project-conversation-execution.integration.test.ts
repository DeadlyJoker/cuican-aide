import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { ExtensionTaskApplicationService } from "@crewon/application";
import { installLocalPluginPackage } from "@crewon/plugin-host";
import { parseInstalledPluginPeerRequest } from "@crewon/contracts/plugins";
import {
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
} from "@crewon/domain";
import {
  businessExecutionFixture,
  digester,
} from "../../runtime-worker/src/installed-plugin-business-execution.integration.test-support.ts";
import { createStandaloneControlApiWithPlugins } from "./standalone-composition.ts";
import { createProductionPostgresControlApi } from "./production-composition.ts";
import { loadDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { loadDesktopNativePluginControlEnvironment } from "./desktop-native-plugin-control-environment.ts";
import { captureNativePluginAuthority } from "./desktop-native-plugin-authority-files.ts";
import { composeDesktopProjectStartup } from "./desktop-project-startup.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { parseInstalledPluginTaskConfiguration } from "./installed-plugin-task-environment.ts";
import {
  projectPluginDisabledScans,
  projectPluginHarness,
  projectPluginHttpsAuthorities,
} from "./creative-project-plugin.integration.test-support.ts";

const directory = process.env.CREWON_TEST_SHORT_DRAMA_PLUGIN_DIR;
const loopbackFetch = globalThis.fetch.bind(globalThis);
const nativeActor = {
  tenantId: "standalone-tenant",
  spaceId: "standalone-space",
  principalId: "standalone-principal",
  actorId: "standalone-actor",
};
const hash = (value: string | Buffer) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
for (const { backend, projectConversationQuotesEnabled } of [
  { backend: "sqlite", projectConversationQuotesEnabled: false },
  { backend: "postgres", projectConversationQuotesEnabled: false },
  { backend: "postgres", projectConversationQuotesEnabled: true },
] as const)
  test(
    `${backend} (qualified quotes ${projectConversationQuotesEnabled ? "declared" : "absent"}): actual Control project-stage POST checks installed Node actions, commits one original Run and replays the same plain chat through the issued task Core`,
    {
      skip:
        !directory ||
        (backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL),
      timeout: 60000,
    },
    async (t) => {
      let runtime:
          | Awaited<ReturnType<typeof createStandaloneControlApiWithPlugins>>
          | undefined,
        nativeTree: string | undefined;
      t.after(async () => {
        await runtime?.app.close();
        if (nativeTree !== undefined) await writableDirectories(nativeTree);
      });
      const originalCreate =
        ExtensionTaskApplicationService.prototype
          .createProjectConversationTurnFromHost;
      t.mock.method(
        ExtensionTaskApplicationService.prototype,
        "createProjectConversationTurnFromHost",
        async function (
          this: ExtensionTaskApplicationService,
          ...args: Parameters<typeof originalCreate>
        ) {
          try {
            return await originalCreate.apply(this, args);
          } catch (error) {
            for (
              let item: unknown = error, depth = 0;
              item instanceof Error && depth < 5;
              item = item.cause, depth++
            )
              t.diagnostic(`${item.name}: ${item.message}`);
            throw error;
          }
        },
      );
      const f = await businessExecutionFixture(t, backend, {
        ...(backend === "sqlite"
          ? {
              actor: nativeActor,
              scope: {
                tenantId: nativeActor.tenantId,
                spaceId: nativeActor.spaceId,
                profileId: "native-stage-profile",
              },
            }
          : {}),
        packageDirectory: directory!,
        configurationParameters: {
          baseUrl: "https://comfy.example.invalid/",
          preset: "krea2-portrait",
        },
        taskAction: { contributionId: "workbench", action: "project.execute" },
        taskClock: { now: () => new Date().toISOString() },
        projectTools: {
          version: "crewon.project-tools.v1",
          authorization: { authorize: async () => ({ outcome: "allow" }) },
        },
      });
      const actor = f.actor,
        scope = f.scope;
      const identity = f.entry.registration.identity,
        descriptor = f.pkg.installed.descriptor;
      assert.equal(identity.version, "16.0.0");
      assert.equal(
        identity.packageDigest,
        "sha256:536aed576dd9ac7080ce030e819a8de8d0ca773139ca0e180f05591161608b8c",
      );
      assert.ok(descriptor.entrypoints.ui);
      const publication = {
        pluginId: identity.pluginId,
        packageDigest: identity.packageDigest,
        contributionId: "workbench",
      };
      const projects = {
        version: "crewon.desktop-project-history.v1",
        pluginUi: { publications: [publication] },
        textArtifacts: { version: "crewon.project-text.v1" },
        conversations: { publications: [publication] },
      };
      const activation = await f.extensions.loadExtensionActivation({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        pluginId: identity.pluginId,
      });
      assert.ok(activation?.target);
      const peerOrigin = "http://127.0.0.1:3299",
        peerRequests: string[] = [];
      // Only the private transport boundary is named. Catalog/configuration/readiness below use the actual installed host and stored deployment, never a fabricated ready result.
      const peerFetch: typeof globalThis.fetch = async (_url, init) => {
        try {
          const input = parseInstalledPluginPeerRequest(
            JSON.parse(String(init?.body)),
          );
          assert.deepEqual(input.actor, actor);
          assert.deepEqual(input.scope, scope);
          peerRequests.push(input.operation);
          const common = {
            protocol: "crewon.installed-plugin-peer-response.v1",
            requestId: input.requestId,
            operation: input.operation,
            actor,
            scope,
          };
          const entry = {
            identity: {
              ...identity,
              manifestDigest: f.entry.registration.manifestDigest,
              implementationDigest: f.entry.registration.implementationDigest,
            },
            configuration: f.entry.configuration,
            configuredTarget: activation.target!,
            manifest: f.entry.registration.manifest,
          };
          if (input.operation === "catalog")
            return Response.json({ ...common, entries: [entry] });
          if (input.operation === "validateConfiguration") {
            await f.host.validateConfiguration({
              actor,
              registration: f.entry.registration,
              configuration: parseExtensionConfiguration(
                input.configuration,
                digester,
              ),
            });
            return Response.json({
              ...common,
              identity: input.identity,
              configurationDigest: input.configuration.contentDigest,
            });
          }
          if (
            input.operation === "readiness" ||
            input.operation === "prepareCandidate"
          ) {
            const result = await f.host.evaluate({
              actor,
              registration: f.entry.registration,
              configuration: parseExtensionConfiguration(
                input.configuration,
                digester,
              ),
              agentVersionId: parseExtensionExecutionTarget(
                input.expectedTarget,
              ).agentVersionId,
            });
            return Response.json({
              ...common,
              identity: input.identity,
              configurationDigest: input.configuration.contentDigest,
              expectedTarget: input.expectedTarget,
              ...(input.operation === "prepareCandidate"
                ? { expectedSelectionRevision: input.expectedSelectionRevision }
                : {}),
              result,
            });
          }
          throw new Error("named_conversation_peer_operation_unexpected");
        } catch (error) {
          if (error instanceof Error)
            t.diagnostic(
              `peer boundary: ${error.message}; ${error.stack?.split("\n").slice(1, 3).join(";")}`,
            );
          throw error;
        }
      };
      let headers: Readonly<Record<string, string>>;
      let qualifiedQuoteCalls = 0;
      if (backend === "sqlite") {
        const databasePath = await realpath(f.databasePath),
          root = dirname(databasePath),
          installRoot = join(root, "plugins"),
          files = {
            approval: join(root, "plugin-approvals.json"),
            profile: join(root, "plugin-profile.json"),
            policy: join(root, "plugin-native-policy.json"),
          };
        nativeTree = installRoot;
        await mkdir(installRoot, { mode: 0o700 });
        const nativeInstalled = await installLocalPluginPackage({
          directory: directory!,
          installRoot,
          authorization: async () => ({ outcome: "allow" }),
        });
        assert.equal(nativeInstalled.packageDigest, identity.packageDigest);
        const source = {
          sourceId: "frozen-short16",
          directory: directory!,
          ...identity,
        };
        const raw = {
          schemaVersion: "crewon.desktop-plugin-bootstrap.v2",
          actor,
          scope,
          authorityEpoch: "named-control-stage-current-epoch-01",
          installRoot,
          sources: [source],
          publications: [
            {
              pluginId: identity.pluginId,
              publisherId: identity.publisherId,
              packageDigest: identity.packageDigest,
              publicAssets: [descriptor.entrypoints.ui.path],
            },
          ],
          projects,
        };
        const bytes = Buffer.from(JSON.stringify(raw)),
          bootstrapPath = join(
            root,
            `plugin-bootstrap-${createHash("sha256").update(bytes).digest("hex")}.json`,
          );
        await writeFile(bootstrapPath, bytes, { mode: 0o600 });
        await writeFile(
          files.approval,
          JSON.stringify({
            schemaVersion: "crewon.desktop-plugin-approval.v2",
            sources: [source],
            publications: raw.publications,
            projects,
          }),
          { mode: 0o600 },
        );
        await writeFile(
          files.profile,
          JSON.stringify({
            schemaVersion: "crewon.desktop-plugin-profile.v1",
            actor,
            scope,
          }),
          { mode: 0o600 },
        );
        await writeFile(
          files.policy,
          JSON.stringify({
            schemaVersion: "crewon.desktop-native-plugin-policy.v1",
            packages: [{ ...identity, approvalRequirement: "none" }],
            networkGrants: [],
          }),
          { mode: 0o600 },
        );
        const owned = join(root, ".native-plugin-authority-stage"),
          prepared = join(root, ".installed-plugin-preparation-stage");
        await mkdir(owned, { mode: 0o700 });
        await mkdir(prepared, { mode: 0o700 });
        const authorityPath = join(owned, "authority.json"),
          controlPath = join(prepared, "native-control.json");
        await writeFile(
          authorityPath,
          JSON.stringify({
            schemaVersion: "crewon.desktop-native-plugin-authority.v1",
            authorityId: "named-native-stage-file-authority",
            actor,
            scope,
            installRoot: raw.installRoot,
            controlDatabasePath: databasePath,
            bootstrapPath,
            bootstrapDigest: hash(bytes),
            approvalPath: files.approval,
            approvalDigest: hash(await readFile(files.approval)),
            profilePath: files.profile,
            profileDigest: hash(await readFile(files.profile)),
            policyPath: files.policy,
            policyDigest: hash(await readFile(files.policy)),
            packages: [identity],
            networkGrants: [],
          }),
          { mode: 0o600 },
        );
        await writeFile(
          controlPath,
          JSON.stringify({
            schemaVersion: "crewon.desktop-native-plugin-control.v1",
            authorityPath,
            peer: {
              origin: peerOrigin,
              tokenEnvironmentVariable:
                "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN",
            },
            entries: [
              {
                identity: {
                  ...identity,
                  manifestDigest: f.entry.registration.manifestDigest,
                  implementationDigest:
                    f.entry.registration.implementationDigest,
                },
                configuration: f.entry.configuration,
                configuredTarget: activation.target,
              },
            ],
          }),
          { mode: 0o600 },
        );
        const configuration = await loadDesktopPluginConfiguration(
          bootstrapPath,
          { actor },
        );
        captureNativePluginAuthority(authorityPath).assertCurrent();
        const nativeControl = loadDesktopNativePluginControlEnvironment(
          {
            CREWON_DESKTOP_NATIVE_PLUGIN_CONTROL_PATH: controlPath,
            CREWON_DESKTOP_NATIVE_PLUGIN_AUTHORITY_PATH: authorityPath,
            CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN: "p".repeat(32),
          },
          {
            securityMode: "standalone",
            desktopBootstrapPath: bootstrapPath,
            databasePath,
          },
        );
        assert.ok(nativeControl);
        t.mock.method(globalThis, "fetch", peerFetch);
        headers = {
          "authorization": `Bearer ${"s".repeat(32)}`,
          "origin": "crewon://desktop",
          "x-csrf-token": "c".repeat(32),
        };
        runtime = await createStandaloneControlApiWithPlugins({
          databasePath,
          actor,
          defaultAgentVersionId: "business-base-agent",
          sessionToken: "s".repeat(32),
          csrfToken: "c".repeat(32),
          allowedOrigins: ["crewon://desktop"],
          artifactStore: new InMemoryArtifactStore(),
          artifactEncryptionKeyId: "fixture-key",
          ...projectPluginDisabledScans,
          desktopPlugins: configuration,
          desktopNativePluginControl: nativeControl,
          ...composeDesktopProjectStartup({ configuration, actor }),
        });
      } else {
        const authority = await projectPluginHttpsAuthorities(t);
        authority.state.actor = { ...actor };
        authority.state.profileId = scope.profileId;
        headers = authority.headers;
        const transport: typeof globalThis.fetch = async (input, init) => {
          const url = String(input);
          if (url.startsWith(peerOrigin)) return peerFetch(input, init);
          if (url === "https://named-conversation-policy.test/package")
            return Response.json({ outcome: "allow" });
          if (url === "https://named-conversation-policy.test/quote") {
            const quote = JSON.parse(String(init?.body));
            assert.deepEqual(
              Object.keys(quote).sort(),
              [
                "schemaVersion",
                "actor",
                "binding",
                "input",
                "commandRequestDigest",
                "projectStageAdmission",
              ].sort(),
            );
            assert.equal(
              quote.schemaVersion,
              "crewon.project-conversation-credit-quote.v1",
            );
            assert.deepEqual(quote.actor, actor);
            assert.equal(quote.binding.inputDigest, hash(quote.input.prompt));
            assert.equal(
              quote.projectStageAdmission.userContentDigest,
              quote.binding.inputDigest,
            );
            assert.equal(
              quote.projectStageAdmission.extensionBindingDigest,
              quote.binding.bindingDigest,
            );
            assert.equal(
              quote.projectStageAdmission.requestDigest,
              quote.commandRequestDigest,
            );
            assert.equal(
              quote.projectStageAdmission.installation.packageDigest,
              identity.packageDigest,
            );
            qualifiedQuoteCalls++;
            return Response.json({
              poolId: f.creditScope.poolId,
              priceRevision: 1,
              quotedCredits: "30",
            });
          }
          return authority.fetch(input, init);
        };
        t.mock.method(globalThis, "fetch", transport);
        const ui = parseProductionPluginUiConfiguration({
          installRoot: f.pkg.input.installRoot,
          profileAuthority: authority.profileAuthority,
          policyAuthority: authority.policyAuthority,
          timeoutMs: 2000,
          publications: [
            {
              pluginId: identity.pluginId,
              publisherId: identity.publisherId,
              packageDigest: identity.packageDigest,
              publicAssets: [descriptor.entrypoints.ui.path],
            },
          ],
        });
        const taskConfiguration = parseInstalledPluginTaskConfiguration(
          {
            schemaVersion: "crewon.installed-plugin-control-tasks.v1",
            installRoot: f.pkg.input.installRoot,
            peer: {
              origin: peerOrigin,
              tokenEnvironmentVariable: "TEST_STAGE_PEER_TOKEN",
            },
            packageAuthority: {
              url: "https://named-conversation-policy.test/package",
              serviceTokenEnvironmentVariable: "TEST_STAGE_POLICY_TOKEN",
            },
            quoteAuthority: {
              url: "https://named-conversation-policy.test/quote",
              serviceTokenEnvironmentVariable: "TEST_STAGE_POLICY_TOKEN",
            },
            timeoutMs: 2000,
            maximumPackages: 32,
            ...(projectConversationQuotesEnabled
              ? {
                  projectConversationQuotes: {
                    version: "crewon.project-conversation-credit-quote.v1",
                  },
                }
              : {}),
          },
          {
            TEST_STAGE_PEER_TOKEN: "p".repeat(32),
            TEST_STAGE_POLICY_TOKEN: "t".repeat(32),
          },
        );
        runtime = await createProductionPostgresControlApi({
          connectionString: f.connectionString!,
          schema: f.schema,
          maxPoolSize: 1,
          statementTimeoutMs: 5000,
          identity: authority.identity,
          authorization: { authorize: async () => ({ outcome: "allow" }) },
          artifactStore: new InMemoryArtifactStore(),
          artifactEncryptionKeyId: "fixture-key",
          ...projectPluginDisabledScans,
          pluginTasks: { configuration: taskConfiguration },
          pluginUi: { configuration: ui },
          creativeProjects: {
            authorization: { authorize: async () => ({ outcome: "allow" }) },
            pluginUi: projects.pluginUi,
            textArtifacts: { version: "crewon.project-text.v1" },
            conversations: projects.conversations,
          },
        });
      }
      const h = projectPluginHarness(() => runtime!.app, headers),
        lease = await h.mount({ sourceId: "frozen-short16", ...identity }, 2);
      const created = await h.request(
        "POST",
        "/api/v1/creative-projects",
        { title: "同一项目", briefText: "真实原对话阶段" },
        "stage-project-create",
      );
      assert.equal(created.statusCode, 200, created.body);
      const projectId = created.json().project.projectId;
      const conversation = await h.request(
        "POST",
        `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
        {
          action: "crewon.project-conversations.v1.createConversation",
          input: {
            projectId,
            workspaceId: null,
            title: "项目原会话",
            idempotencyKey: "stage-conversation-create",
          },
        },
      );
      assert.equal(conversation.statusCode, 200, conversation.body);
      const binding = conversation.json().output.binding;
      const thread = await h.request(
        "GET",
        `/api/v1/threads/${binding.threadId}`,
      );
      assert.equal(thread.statusCode, 200, thread.body);
      const original = {
        projectId,
        threadId: binding.threadId,
        expectedThreadRevision: thread.json().thread.revision,
        expectedBindingRevision: binding.revision,
        content: " 原话\n保留在原聊天 ",
        idempotencyKey: "stage-original-turn",
        stage: { kind: "discussion" },
      };
      const accepted = await h.request(
        "POST",
        `/api/v1/threads/${binding.threadId}/project-conversation/stages`,
        original,
        original.idempotencyKey,
      );
      if (backend === "postgres" && !projectConversationQuotesEnabled) {
        assert.equal(accepted.statusCode, 409, accepted.body);
        assert.equal(
          accepted.json().error.code,
          "extension_project_conversation_credit_quote_unavailable",
        );
        assert.equal(await f.count("run_snapshots"), 0);
        assert.equal(await f.count("plugin_task_admissions"), 0);
        assert.equal(qualifiedQuoteCalls, 0);
        assert.equal(f.controls.models.length, 0);
        assert.equal(f.controls.executes.length, 0);
        return;
      }
      assert.equal(accepted.statusCode, 201, accepted.body);
      const result = accepted.json();
      const replay = await h.request(
        "POST",
        `/api/v1/threads/${binding.threadId}/project-conversation/stages`,
        original,
        original.idempotencyKey,
      );
      assert.equal(replay.statusCode, 200, replay.body);
      assert.deepEqual(replay.json(), { ...result, disposition: "replayed" });
      const run = await h.request("GET", `/api/v1/runs/${result.runId}`);
      assert.equal(run.statusCode, 200, run.body);
      assert.equal(run.json().run.threadId, binding.threadId);
      const messages = await h.request(
        "GET",
        `/api/v1/threads/${binding.threadId}/messages`,
      );
      assert.equal(messages.statusCode, 200, messages.body);
      assert.ok(
        JSON.stringify(messages.json()).includes(
          JSON.stringify(original.content).slice(1, -1),
        ),
      );
      const origin = await runtime!.app.listen({ host: "127.0.0.1", port: 0 });
      const controller = new AbortController(),
        stream = await loopbackFetch(
          `${origin}/api/v1/runs/${encodeURIComponent(result.runId)}/events`,
          {
            headers,
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(5000),
            ]),
          },
        );
      assert.equal(stream.status, 200);
      assert.match(stream.headers.get("content-type")!, /text\/event-stream/u);
      assert.ok(stream.body);
      const reader = stream.body.getReader();
      try {
        const first = await reader.read();
        assert.equal(first.done, false);
        const chunk = new TextDecoder().decode(first.value);
        assert.match(chunk, /id: 1/u);
        assert.ok(chunk.includes(result.runId));
      } finally {
        await reader.cancel();
        controller.abort();
        reader.releaseLock();
      }
      const resumed = await loopbackFetch(
        `${origin}/api/v1/runs/${encodeURIComponent(result.runId)}/events`,
        {
          headers: { ...headers, "last-event-id": "1" },
          signal: AbortSignal.timeout(5000),
        },
      );
      assert.equal(resumed.status, 200);
      await resumed.body!.cancel();
      assert.equal(await f.count("run_snapshots"), 1);
      assert.equal(await f.count("plugin_task_admissions"), 1);
      assert.equal(peerRequests.includes("readiness"), true);
      assert.equal(qualifiedQuoteCalls, backend === "postgres" ? 1 : 0);
      assert.equal(f.controls.models.length, 0);
      assert.equal(f.controls.executes.length, 0);
      assert.equal(f.controls.reconciles.length, 0);
    },
  );

async function writableDirectories(path: string): Promise<void> {
  await chmod(path, 0o700);
  for (const item of await readdir(path, { withFileTypes: true }))
    if (item.isDirectory()) await writableDirectories(join(path, item.name));
}
