import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile, realpath, readdir, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import { InMemoryArtifactStore } from "@crewon/artifacts";
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
import { loadDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { loadDesktopNativePluginControlEnvironment } from "./desktop-native-plugin-control-environment.ts";
import { captureNativePluginAuthority } from "./desktop-native-plugin-authority-files.ts";
import { composeDesktopProjectStartup } from "./desktop-project-startup.ts";
import {
  projectPluginDisabledScans,
  projectPluginHarness,
} from "./creative-project-plugin.integration.test-support.ts";

/** Actual installed source/Control/Core/SQL. Only private deployment files and peer transport are named fixtures; no Main, model or media claim. */
export async function nativeTextPlanFixture(
  t: TestContext,
  directory: string,
  options: Readonly<{ createTransport?(): ModelTransportPort }> = {},
) {
  const runtimes = new Set<
    Awaited<ReturnType<typeof createStandaloneControlApiWithPlugins>>
  >();
  let installRoot: string | undefined;
  t.after(async () => {
    for (const r of runtimes) await r.app.close();
    if (installRoot !== undefined) await writable(installRoot);
  });
  const actor = {
    tenantId: "standalone-tenant",
    spaceId: "standalone-space",
    principalId: "standalone-principal",
    actorId: "standalone-actor",
  };
  const f = await businessExecutionFixture(t, "sqlite", {
    actor,
    scope: {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      profileId: "native-plan-profile",
    },
    packageDirectory: directory,
    configurationParameters: {
      baseUrl: "https://comfy.example.invalid/",
      preset: "krea2-portrait",
    },
    taskAction: { contributionId: "workbench", action: "project.execute" },
    taskClock: { now: () => new Date().toISOString() },
    ...(options.createTransport === undefined
      ? {}
      : { createTransport: options.createTransport.bind(options) }),
    projectTools: {
      version: "crewon.project-tools.v1",
      authorization: { authorize: async () => ({ outcome: "allow" }) },
    },
  });
  const identity = f.entry.registration.identity,
    scope = f.scope;
  assert.equal(identity.version, "17.0.0");
  const descriptor = f.pkg.installed.descriptor;
  assert.ok(
    descriptor.requires.some(
      (r) => r.service === "crewon.project-text-plans" && r.apiVersion === "1",
    ),
  );
  const databasePath = await realpath(f.databasePath),
    root = dirname(databasePath);
  installRoot = join(root, "plugins");
  await mkdir(installRoot, { mode: 0o700 });
  const installed = await installLocalPluginPackage({
    directory,
    installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  assert.equal(installed.packageDigest, identity.packageDigest);
  const publication = {
    pluginId: identity.pluginId,
    packageDigest: identity.packageDigest,
    contributionId: "workbench",
  };
  const publications = [
    {
      pluginId: identity.pluginId,
      publisherId: identity.publisherId,
      packageDigest: identity.packageDigest,
      publicAssets: [descriptor.entrypoints.ui!.path],
    },
  ];
  const source = { sourceId: "source-short17", directory, ...identity };
  const projects = {
    version: "crewon.desktop-project-execution.v1",
    pluginUi: { publications: [publication] },
    textArtifacts: { version: "crewon.project-text.v1" },
    textUi: { publications: [publication] },
    conversations: { publications: [publication] },
    textPlans: { publications: [publication] },
  };
  const raw = {
    schemaVersion: "crewon.desktop-plugin-bootstrap.v3",
    actor,
    scope,
    authorityEpoch: "named-native-plan-current-epoch-0001",
    installRoot,
    sources: [source],
    publications,
    projects,
  };
  const files = {
    approval: join(root, "plugin-approvals.json"),
    profile: join(root, "plugin-profile.json"),
    policy: join(root, "plugin-native-policy.json"),
  };
  const put = async (path: string, value: unknown) =>
    writeFile(path, JSON.stringify(value), { mode: 0o600 });
  const hash = (value: Buffer) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const bytes = Buffer.from(JSON.stringify(raw)),
    bootstrapPath = join(
      root,
      `plugin-bootstrap-${createHash("sha256").update(bytes).digest("hex")}.json`,
    );
  await writeFile(bootstrapPath, bytes, { mode: 0o600 });
  const approval = {
    schemaVersion: "crewon.desktop-plugin-approval.v2",
    sources: [source],
    publications,
    projects,
  };
  const profile = {
    schemaVersion: "crewon.desktop-plugin-profile.v1",
    actor,
    scope,
  };
  const policy = {
    schemaVersion: "crewon.desktop-native-plugin-policy.v1",
    packages: [{ ...identity, approvalRequirement: "none" }],
    networkGrants: [],
  };
  await put(files.approval, approval);
  await put(files.profile, profile);
  await put(files.policy, policy);
  const owned = join(root, ".native-plugin-authority-plan"),
    prepared = join(root, ".installed-plugin-preparation-plan");
  await mkdir(owned, { mode: 0o700 });
  await mkdir(prepared, { mode: 0o700 });
  const authorityPath = join(owned, "authority.json"),
    controlPath = join(prepared, "native-control.json"),
    peerOrigin = "http://127.0.0.1:3299";
  const activation = await f.extensions.loadExtensionActivation({
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    pluginId: identity.pluginId,
  });
  assert.ok(activation?.target);
  await put(authorityPath, {
    schemaVersion: "crewon.desktop-native-plugin-authority.v1",
    authorityId: "named-plan-file-authority",
    actor,
    scope,
    installRoot,
    controlDatabasePath: databasePath,
    bootstrapPath,
    bootstrapDigest: hash(bytes),
    approvalPath: files.approval,
    approvalDigest: hash(Buffer.from(JSON.stringify(approval))),
    profilePath: files.profile,
    profileDigest: hash(Buffer.from(JSON.stringify(profile))),
    policyPath: files.policy,
    policyDigest: hash(Buffer.from(JSON.stringify(policy))),
    packages: [identity],
    networkGrants: [],
  });
  await put(controlPath, {
    schemaVersion: "crewon.desktop-native-plugin-control.v1",
    authorityPath,
    peer: {
      origin: peerOrigin,
      tokenEnvironmentVariable: "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN",
    },
    entries: [
      {
        identity: {
          ...identity,
          manifestDigest: f.entry.registration.manifestDigest,
          implementationDigest: f.entry.registration.implementationDigest,
        },
        configuration: f.entry.configuration,
        configuredTarget: activation.target,
      },
    ],
  });
  const peerRequests: string[] = [];
  const peerFetch: typeof globalThis.fetch = async (_url, init) => {
    const q = parseInstalledPluginPeerRequest(JSON.parse(String(init?.body)));
    assert.deepEqual(q.actor, actor);
    assert.deepEqual(q.scope, scope);
    peerRequests.push(q.operation);
    const common = {
      protocol: "crewon.installed-plugin-peer-response.v1",
      requestId: q.requestId,
      operation: q.operation,
      actor,
      scope,
    };
    if (q.operation === "catalog")
      return Response.json({
        ...common,
        entries: [
          {
            identity: {
              ...identity,
              manifestDigest: f.entry.registration.manifestDigest,
              implementationDigest: f.entry.registration.implementationDigest,
            },
            configuration: f.entry.configuration,
            configuredTarget: activation.target,
            manifest: f.entry.registration.manifest,
          },
        ],
      });
    if (q.operation === "validateConfiguration") {
      await f.host.validateConfiguration({
        actor,
        registration: f.entry.registration,
        configuration: parseExtensionConfiguration(q.configuration, digester),
      });
      return Response.json({
        ...common,
        identity: q.identity,
        configurationDigest: q.configuration.contentDigest,
      });
    }
    if (q.operation === "readiness" || q.operation === "prepareCandidate") {
      const result = await f.host.evaluate({
        actor,
        registration: f.entry.registration,
        configuration: parseExtensionConfiguration(q.configuration, digester),
        agentVersionId: parseExtensionExecutionTarget(q.expectedTarget)
          .agentVersionId,
      });
      return Response.json({
        ...common,
        identity: q.identity,
        configurationDigest: q.configuration.contentDigest,
        expectedTarget: q.expectedTarget,
        ...(q.operation === "prepareCandidate"
          ? { expectedSelectionRevision: q.expectedSelectionRevision }
          : {}),
        result,
      });
    }
    throw new Error("named_plan_peer_operation_unexpected");
  };
  t.mock.method(globalThis, "fetch", peerFetch);
  const configuration = await loadDesktopPluginConfiguration(bootstrapPath, {
    actor,
  });
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
  const open = async () => {
    const r = await createStandaloneControlApiWithPlugins({
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
    runtimes.add(r);
    return r;
  };
  let runtime = await open();
  const h = projectPluginHarness(() => runtime.app, {
    "authorization": `Bearer ${"s".repeat(32)}`,
    "origin": "crewon://desktop",
    "x-csrf-token": "c".repeat(32),
  });
  let lease = await h.mount(source, 2);
  const invoke = (method: string, input: object) =>
    h.request("POST", `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`, {
      action: `crewon.project-text-plans.v1.${method}`,
      input,
    });
  return {
    f,
    actor,
    scope,
    identity,
    h,
    listen: () => runtime.app.listen({ host: "127.0.0.1", port: 0 }),
    invoke,
    peerRequests,
    close: () => runtime.app.close(),
    reopen: async () => {
      await runtime.app.close();
      runtime = await open();
      lease = await h.mount(source, 2);
    },
    withdraw: () =>
      put(files.approval, {
        ...approval,
        projects: { ...projects, textPlans: undefined },
      }),
    conversation: async () => {
      const project = await h.request(
        "POST",
        "/api/v1/creative-projects",
        { title: "真实计划项目", briefText: "两集都市悬疑" },
        "plan-project",
      );
      assert.equal(project.statusCode, 200, project.body);
      const projectId = project.json().project.projectId;
      const created = await h.request(
        "POST",
        `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
        {
          action: "crewon.project-conversations.v1.createConversation",
          input: {
            projectId,
            workspaceId: null,
            title: "计划对话",
            idempotencyKey: "plan-conversation",
          },
        },
      );
      assert.equal(created.statusCode, 200, created.body);
      return created.json().output.binding;
    },
  };
}
async function writable(path: string): Promise<void> {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await writable(join(path, entry.name));
  }
}
