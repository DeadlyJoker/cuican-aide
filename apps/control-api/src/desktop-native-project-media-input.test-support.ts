import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import Fastify from "fastify";
import { SqliteRunStore } from "@crewon/store";
import { CreativeProjectApplicationService } from "@crewon/application";
import { createExtensionConfiguration } from "@crewon/domain";
import {
  installLocalPluginPackage,
  loadInstalledPluginBusinessRegistration,
} from "@crewon/plugin-host";
import { parseInstalledPluginPeerRequest } from "@crewon/contracts/plugins";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import { activationTarget } from "./desktop-installed-plugin-activation.test-support.ts";
import { loadDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { loadDesktopNativePluginControlEnvironment } from "./desktop-native-plugin-control-environment.ts";
import { createDesktopPluginRuntime } from "./desktop-plugin-runtime.ts";
import { composeDesktopProjectStartup } from "./desktop-project-startup.ts";
import { prepareCreativeProjects } from "./creative-project-composition.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import { registerProjectMediaInputRoutes } from "./project-media-input-route.ts";
import { errorResponse } from "./control-api-errors.ts";
const sha = {
  sha256: (bytes: string | Buffer) =>
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
};
const actor = {
  principalId: "standalone-principal",
  actorId: "standalone-actor",
  tenantId: "standalone-tenant",
  spaceId: "standalone-space",
};
/** Actual Main local identity, file-issued Native Core, installed bytes and original SQLite.
 * Only a project is seeded through its original service. No fabricated references, media receipts or provider proof. */
export async function desktopNativeMediaInputFixture(
  t: TestContext,
  purposes: readonly ("read" | "write")[] = ["read", "write"],
  options: {
    reviewIdentityFixture?: "different-manifest";
    mediaInputUi?: boolean;
  } = {},
) {
  const owners: {
    runtime: Awaited<ReturnType<typeof createDesktopPluginRuntime>>;
    app: ReturnType<typeof Fastify>;
  }[] = [];
  const parents: SqliteRunStore[] = [];
  const files = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      for (const o of owners.slice().reverse()) {
        await o.app.close();
        await o.runtime.close();
      }
      for (const p of parents) await p.close();
    },
  });
  const data = files.root,
    databasePath = join(data, "control.sqlite"),
    installRoot = join(data, "plugins");
  const parent = new SqliteRunStore(databasePath);
  parents.push(parent);
  const projectStore = parent.creativeProjectStore();
  await projectStore.migrate();
  const clock = { now: () => new Date().toISOString() };
  const seedProjects = new CreativeProjectApplicationService({
    store: projectStore,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock,
    ids: { nextId: () => randomUUID() },
    digester: sha,
  });
  const project = await seedProjects.createProject(actor, {
    title: "Native metadata scope",
    briefText: "Named project only; no adopted image yet.",
    idempotencyKey: "native-media-project",
  });
  await mkdir(installRoot, { mode: 0o700 });
  const sourceDirectory = resolve(
    process.env.CREWON_MEDIA_WORKER_PACKAGE_DIR ??
      "output/extensions/installable-plugins/short-drama-media-worker-20261006/short-drama/21.0.1",
  );
  const pkg = await installLocalPluginPackage({
    directory: sourceDirectory,
    installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  const registration = await loadInstalledPluginBusinessRegistration({
    installRoot,
    expectedPluginId: pkg.descriptor.pluginId,
    expectedPublisherId: pkg.descriptor.publisherId,
    expectedVersion: pkg.descriptor.version,
    expectedPackageDigest: pkg.packageDigest,
    authorizeRead: async () => "allow",
    signal: new AbortController().signal,
  });
  const source = {
    sourceId: "native-short21-media",
    directory: sourceDirectory,
    pluginId: pkg.descriptor.pluginId,
    publisherId: pkg.descriptor.publisherId,
    version: pkg.descriptor.version,
    packageDigest: pkg.packageDigest,
  };
  const scope = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "native-media-original-profile",
  };
  const targetIdentity = {
    pluginId: source.pluginId,
    publisherId: source.publisherId,
    version: source.version,
    packageDigest: source.packageDigest,
    manifestDigest: registration.manifestDigest,
    implementationDigest: registration.implementationDigest,
  };
  const mediaInputs = {
    version: "crewon.desktop-project-media-inputs.v1",
    purposes,
    reviews: [
      {
        targetIdentity: {
          ...targetIdentity,
          ...(options.reviewIdentityFixture === undefined
            ? {}
            : { manifestDigest: sha.sha256("named-other-manifest") }),
        },
        workflow: {
          workflowId: "krea2-reference-four-view",
          workflowDigest: sha.sha256("named-reviewed-T10-graph"),
          output: {
            kind: "image",
            nodeId: "129",
            dimensions: "workflow-native",
          },
        },
      },
      {
        targetIdentity,
        workflow: {
          workflowId: "flux2-three-reference-storyboard",
          workflowDigest: sha.sha256("named-reviewed-D18-graph"),
          output: {
            kind: "image",
            nodeId: "17",
            dimensions: "workflow-native",
          },
        },
      },
    ],
    referenceIdentities: [
      {
        pluginId: "crewon.short-drama",
        pluginVersion: source.version,
        manifestDigest: registration.manifestDigest,
        implementationDigest: registration.implementationDigest,
      },
    ],
  };
  const projects = {
    version: "crewon.desktop-project-execution.v1",
    textArtifacts: { version: "crewon.project-text.v1" },
    assetArtifacts: { version: "crewon.project-asset.v1" },
    mediaInputs,
    ...(options.mediaInputUi
      ? {
          mediaInputUi: {
            publications: [
              {
                pluginId: source.pluginId,
                packageDigest: source.packageDigest,
                contributionId: "workbench",
              },
            ],
          },
        }
      : {}),
  };
  const document = {
    schemaVersion: "crewon.desktop-plugin-bootstrap.v3",
    actor,
    scope,
    authorityEpoch: "native-media-metadata-original-epoch-0001",
    installRoot,
    sources: [source],
    publications: [
      {
        pluginId: source.pluginId,
        publisherId: source.publisherId,
        packageDigest: source.packageDigest,
        publicAssets: [pkg.descriptor.entrypoints.ui!.path],
      },
    ],
    projects,
  };
  const write = async (path: string, value: unknown) =>
    writeFile(path, JSON.stringify(value), { mode: 0o600 });
  const bytes = Buffer.from(JSON.stringify(document)),
    bootstrapPath = join(
      data,
      `plugin-bootstrap-${createHash("sha256").update(bytes).digest("hex")}.json`,
    );
  await writeFile(bootstrapPath, bytes, { mode: 0o600 });
  const approvalPath = join(data, "plugin-approvals.json"),
    profilePath = join(data, "plugin-profile.json"),
    policyPath = join(data, "plugin-native-policy.json");
  const packageIdentity = {
    pluginId: source.pluginId,
    publisherId: source.publisherId,
    version: source.version,
    packageDigest: source.packageDigest,
  };
  await write(approvalPath, {
    schemaVersion: "crewon.desktop-plugin-approval.v3",
    sources: document.sources,
    publications: document.publications,
    projects,
  });
  await write(profilePath, {
    schemaVersion: "crewon.desktop-plugin-profile.v1",
    actor,
    scope,
  });
  await write(policyPath, {
    schemaVersion: "crewon.desktop-native-plugin-policy.v1",
    packages: [{ ...packageIdentity, approvalRequirement: "none" }],
    networkGrants: [],
  });
  const authorityDirectory = join(data, ".native-plugin-authority-media-test"),
    controlDirectory = join(data, ".installed-plugin-preparation-media-test");
  await mkdir(authorityDirectory, { mode: 0o700 });
  await mkdir(controlDirectory, { mode: 0o700 });
  const authorityPath = join(authorityDirectory, "authority.json"),
    controlPath = join(controlDirectory, "native-control.json");
  await write(authorityPath, {
    schemaVersion: "crewon.desktop-native-plugin-authority.v1",
    authorityId: "native-media-metadata-original-authority",
    actor,
    scope,
    installRoot,
    controlDatabasePath: databasePath,
    bootstrapPath,
    bootstrapDigest: sha.sha256(bytes),
    approvalPath,
    approvalDigest: sha.sha256(await readFile(approvalPath)),
    profilePath,
    profileDigest: sha.sha256(await readFile(profilePath)),
    policyPath,
    policyDigest: sha.sha256(await readFile(policyPath)),
    packages: [packageIdentity],
    networkGrants: [],
  });
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      pluginId: source.pluginId,
      revision: 1,
      pluginVersion: source.version,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      parameters: {
        baseUrl: "https://named-comfy.provider.example:8443/",
        preset: "krea2-portrait",
      },
      credentialBindings: [],
      createdByActorId: actor.actorId,
      createdAt: clock.now(),
    },
    sha,
  );
  const entry = {
    identity: targetIdentity,
    configuration,
    configuredTarget: activationTarget,
  };
  await write(controlPath, {
    schemaVersion: "crewon.desktop-native-plugin-control.v1",
    authorityPath,
    peer: {
      origin: "http://127.0.0.1:3299",
      tokenEnvironmentVariable: "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN",
    },
    entries: [entry],
  });
  const peer: string[] = [];
  const open = async (store: SqliteRunStore) => {
    const nativeControl = loadDesktopNativePluginControlEnvironment(
      {
        CREWON_DESKTOP_NATIVE_PLUGIN_CONTROL_PATH: controlPath,
        CREWON_DESKTOP_NATIVE_PLUGIN_AUTHORITY_PATH: authorityPath,
        CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN:
          "named-offline-peer-" + "p".repeat(32),
      },
      {
        securityMode: "standalone",
        desktopBootstrapPath: bootstrapPath,
        databasePath,
      },
    );
    assert.ok(nativeControl);
    const bootstrap = await loadDesktopPluginConfiguration(bootstrapPath, {
      actor,
    });
    const csrf = "named-native-media-csrf-" + "c".repeat(32),
      token = "named-native-media-session-" + "s".repeat(32),
      origin = "http://127.0.0.1:18479";
    const identity = new StandaloneIdentity({
      actor,
      sessionToken: token,
      csrfToken: csrf,
      allowedOrigins: [origin],
    });
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const p = parseInstalledPluginPeerRequest(JSON.parse(String(init?.body)));
      peer.push(p.operation);
      if (p.operation !== "catalog")
        throw new Error("named_media_metadata_must_not_prepare_execution");
      return Response.json({
        protocol: "crewon.installed-plugin-peer-response.v1",
        requestId: p.requestId,
        operation: p.operation,
        actor,
        scope,
        entries: [{ ...entry, manifest: registration.manifest }],
      });
    };
    const startup = composeDesktopProjectStartup({
      configuration: bootstrap,
      actor,
      nativeControl,
    });
    const prepared = await prepareCreativeProjects(
      store,
      startup.creativeProjects,
      { financialMode: "unmetered" },
    );
    const runtime = await createDesktopPluginRuntime(
      { configuration: bootstrap, nativeControl },
      {
        store,
        identity,
        clock,
        digester: sha,
        creativeProjects: prepared,
        fetch,
      },
    );
    const app = Fastify();
    owners.push({ runtime, app });
    assert.ok(runtime.tasks?.projectMediaInputs);
    app.setErrorHandler((error, request, reply) => {
      const e = errorResponse(error, request.id);
      return reply.code(e.statusCode).send(e.body);
    });
    registerProjectMediaInputRoutes(app, {
      identity,
      owner: runtime.tasks.projectMediaInputs,
    });
    const headers = {
      "authorization": `Bearer ${token}`,
      origin,
      "x-csrf-token": csrf,
    };
    const request = () => ({
      method: "POST",
      url: `/api/v1/creative-projects/${project.project.projectId}/media-inputs`,
      remoteAddress: "127.0.0.1",
      headers,
    });
    return {
      runtime,
      app,
      bootstrap,
      nativeControl,
      startup,
      prepared,
      identity,
      headers,
      request,
      parent: store,
    };
  };
  const current = await open(parent);
  const reopen = async () => {
    await parent.close();
    const next = new SqliteRunStore(databasePath);
    parents.push(next);
    return open(next);
  };
  const query = {
    projectId: project.project.projectId,
    mediaInputId: "native-media-not-created",
    inputRevision: null,
  };
  const command = {
    mediaInputId: null,
    expectedInputRevision: 0,
    item: {
      kind: "character-reference",
      assetId: "native-character-not-adopted",
    },
    briefRevision: 1,
    script: null,
    workflowId: "krea2-reference-four-view",
    configurationRevision: 1,
    prompt: "Confirmed input still needs its actual reference.",
    references: {
      character: {
        projectId: query.projectId,
        assetId: "native-character-not-adopted",
        kind: "character",
        expectedAssetRevision: 4,
        contentRevision: 1,
        referenceRevision: 1,
      },
    },
  };
  return {
    ...current,
    actor,
    scope,
    query,
    command,
    mediaInputs,
    entry,
    peer,
    project,
    approvalPath,
    bootstrapPath,
    authorityPath,
    controlPath,
    profilePath,
    policyPath,
    reopen,
  };
}
