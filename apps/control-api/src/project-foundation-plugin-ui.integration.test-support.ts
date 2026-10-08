import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import Fastify from "fastify";
import {
  installLocalPluginPackage,
  assertPluginUiHostServiceAvailability,
} from "@crewon/plugin-host";
import {
  PROJECT_FOUNDATION_UI_METHOD_ACTIONS,
  projectFoundationUiCodec,
  type ProjectFoundationUiMethod,
  type ProjectFoundationUiInputMap,
} from "@crewon/contracts/project-foundation";
import {
  actor,
  pluginCommitFixture,
  type Backend,
} from "../../../packages/store/src/creative-project-plugin-commit.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import { prepareCreativeProjects } from "./creative-project-composition.ts";
import {
  projectGenerationHttpsAuthority,
  projectGenerationProductionIdentity,
} from "./production-project-generation-ui.integration.test-support.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { createProductionProjectFoundationPluginRuntime } from "./production-project-foundation-plugin-runtime.ts";
import { createProductionPluginUiRuntime } from "./production-plugin-ui-composition.ts";
import { createProductionPluginUiRequestService } from "./production-plugin-ui-request-service.ts";
import { registerPluginControlRoutes } from "./plugin-control-route.ts";
import { createProductionProjectSourceUploadPluginRuntime } from "./production-project-source-upload-plugin-runtime.ts";
import {
  PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS,
  projectSourceUploadsCodec,
  projectSourceUploadPartPath,
  parseProjectSourceUploadPartResponse,
  type ProjectSourceUploadMethod,
  type ProjectSourceUploadInputMap,
  type ProjectSourceUploadPartLocator,
} from "@crewon/contracts/project-source-uploads";
import { errorResponse } from "./control-api-errors.ts";

/** Real installed bytes, original SQL parent, live HTTPS profile/policy and formal HTTP action routes.
 * Optional raw uploads traverse the formal mounted HTTP route; Node Run, model execution and renderer execution remain outside this fixture. */
export async function foundationUiHttpFixture(
  t: TestContext,
  backend: Backend,
  options: Readonly<{ uploads?: true }> = {},
) {
  const f = await pluginCommitFixture(t, backend);
  const directory = await mkdtemp(join(tmpdir(), "crewon-foundation-ui-"));
  const installRoot = join(directory, "installed");
  const sourceDirectory = join(directory, "source");
  await mkdir(installRoot, { mode: 0o700 });
  await mkdir(sourceDirectory, { mode: 0o700 });
  t.after(async () => {
    await writableTree(directory);
    await rm(directory, { recursive: true, force: true });
  });
  const pluginId = "example.foundation-workbench";
  const uiBytes =
    "export default {apiVersion:'crewon.plugin-ui.v1',pluginId:'example.foundation-workbench',mount(){return {update(){},dispose(){}}}};";
  await writeFile(join(sourceDirectory, "ui.mjs"), uiBytes);
  await writeFile(
    join(sourceDirectory, "crewon.plugin.json"),
    JSON.stringify({
      schemaVersion: "crewon.plugin-package.v1",
      hostApi: "crewon.plugin-host.v1",
      pluginId,
      version: "1.0.0",
      title: "Foundation workbench",
      description: "Installed foundation protocol fixture",
      publisherId: "example.foundation-publisher",
      entrypoints: {
        node: null,
        ui: { path: "ui.mjs", mode: "trustedModule" },
      },
      businessManifestPath: null,
      requires: [
        ...(options.uploads
          ? [
              {
                service: "crewon.project-source-uploads",
                apiVersion: "1",
                optional: false,
              },
            ]
          : []),
        {
          service: "crewon.project-foundation",
          apiVersion: "1",
          optional: false,
        },
      ],
      provides: [],
      contributions: [
        {
          id: "workbench",
          kind: "module",
          slot: "main.content",
          title: "Foundation",
        },
      ],
      files: [
        {
          path: "ui.mjs",
          byteLength: Buffer.byteLength(uiBytes),
          sha256: createHash("sha256").update(uiBytes).digest("hex"),
        },
      ],
    }),
  );
  const installed = await installLocalPluginPackage({
    directory: sourceDirectory,
    installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  const recorded = await f.installations.recordInstalledPackage(
    installationRecipe("foundation-http-install", {
      scope: f.scope,
      actor,
      pluginId,
      publisherId: installed.descriptor.publisherId,
      version: installed.descriptor.version,
      packageDigest: installed.packageDigest,
    }),
  );
  const enabled = await f.installations.commitSelection(
    selectionRecipe(recorded.selection, "foundation-http-enable", { actor }),
  );
  const state = {
    businessAllowed: true,
    active: true,
    fallbackCalls: 0,
    uploadBusinessAllowed: true,
    uploadActive: true,
    uploadPermissions: [] as string[],
  };
  const publications = [
    {
      pluginId,
      packageDigest: installed.packageDigest,
      contributionId: "workbench",
    },
  ];
  const projects = await prepareCreativeProjects(f.parent, {
    authorization: {
      authorize: async () =>
        state.businessAllowed
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "foundation_business_withdrawn" },
    },
    foundation: {
      version: "crewon.project-foundation.v1",
      pluginUi: { publications },
      uploads: {
        version: "crewon.project-source-uploads.v1",
        ...(options.uploads ? { pluginUi: { publications } } : {}),
        authorization: {
          authorize: async (permission) => {
            state.uploadPermissions.push(permission.action);
            return options.uploads &&
              state.uploadBusinessAllowed &&
              state.uploadActive
              ? { outcome: "allow" }
              : {
                  outcome: "deny",
                  reasonCode: options.uploads
                    ? "upload_business_withdrawn"
                    : "raw_upload_not_part_of_this_fixture",
                };
          },
          assertActive: () => {
            if (
              !state.active ||
              !state.uploadActive ||
              !state.uploadBusinessAllowed
            )
              throw new Error("upload_business_withdrawn");
          },
        },
      },
    },
  });
  assert.ok(projects?.foundation);
  const authority = await projectGenerationHttpsAuthority(t, {
    actor,
    profile: f.scope,
    sourceId: pluginId,
    sourceEpoch: () => "foundation-http-epoch",
    targetEpoch: () => "unrelated-epoch",
  });
  const authentication = projectGenerationProductionIdentity(actor);
  const configuration = parseProductionPluginUiConfiguration({
    installRoot,
    profileAuthority: authority.profileAuthority,
    policyAuthority: authority.policyAuthority,
    publications: [
      {
        pluginId,
        packageDigest: installed.packageDigest,
        publisherId: installed.descriptor.publisherId,
        publicAssets: ["ui.mjs"],
      },
    ],
    timeoutMs: 1000,
  });
  const foundation = createProductionProjectFoundationPluginRuntime({
    projects,
    ui: configuration,
    identity: authentication.identity,
    fetch: authority.fetch,
  });
  assert.ok(foundation);
  const uploads = options.uploads
    ? createProductionProjectSourceUploadPluginRuntime({
        projects,
        ui: configuration,
        identity: authentication.identity,
        fetch: authority.fetch,
        hostUiServices: foundation.hostUiServices,
      })
    : undefined;
  if (options.uploads) assert.ok(uploads);
  assertPluginUiHostServiceAvailability({
    scope: f.scope,
    candidate: {
      descriptor: installed.descriptor,
      packageDigest: installed.packageDigest,
    },
    hostUiServices: uploads?.hostUiServices ?? foundation.hostUiServices,
  });
  const ui = createProductionPluginUiRuntime(
    {
      configuration,
      ownedProjectFoundationActions: foundation.owner,
      ...(uploads ? { ownedProjectSourceUploadActions: uploads.owner } : {}),
      actions: {
        invoke: async () => {
          state.fallbackCalls++;
          return { fallback: true };
        },
      },
    },
    {
      ledger: f.installations,
      clock: { now: () => new Date().toISOString() },
      fetch: authority.fetch,
    },
  );
  const service = createProductionPluginUiRequestService({
    ui: ui.service,
    foundations: foundation,
    ...(uploads ? { sourceUploads: uploads } : {}),
  });
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => {
    const result = errorResponse(error, request.id);
    reply.code(result.statusCode).send(result.body);
  });
  registerPluginControlRoutes(app, {
    identity: authentication.identity,
    pluginUi: service,
  });
  t.after(async () => {
    state.active = false;
    state.uploadActive = false;
    await app.close();
    await uploads?.close();
    await foundation.close();
    await ui.close();
  });
  const mounted = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/ui/mounts",
    headers: authentication.headers,
    payload: {
      pluginId,
      contributionId: "workbench",
      expectedSelectionRevision: enabled.selection.revision,
      expectedPackageDigest: installed.packageDigest,
    },
  });
  assert.equal(mounted.statusCode, 200, mounted.body);
  const lease = mounted.json();
  const invokeRaw = (action: string, input: unknown) =>
    app.inject({
      method: "POST",
      url: `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      headers: authentication.headers,
      payload: { action, input },
    });
  async function invoke<M extends ProjectFoundationUiMethod>(
    method: M,
    input: ProjectFoundationUiInputMap[M],
  ) {
    const action = PROJECT_FOUNDATION_UI_METHOD_ACTIONS[method];
    const response = await invokeRaw(action, input);
    assert.equal(response.statusCode, 200, response.body);
    const request = projectFoundationUiCodec.parseRequest({ action, input });
    return projectFoundationUiCodec.parseResponse(
      response.json().output,
      request,
    );
  }
  async function invokeUpload<M extends ProjectSourceUploadMethod>(
    method: M,
    input: ProjectSourceUploadInputMap[M],
  ) {
    const action = PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS[method];
    const response = await invokeRaw(action, input);
    assert.equal(response.statusCode, 200, response.body);
    return projectSourceUploadsCodec.parseResponse(
      response.json().output,
      projectSourceUploadsCodec.parseRequest({ action, input }),
    );
  }
  const partRaw = (
    locator: ProjectSourceUploadPartLocator,
    bytes: Uint8Array,
    request: Readonly<{
      mountRef?: string;
      url?: string;
      contentType?: string;
      contentEncoding?: string;
    }> = {},
  ) =>
    app.inject({
      method: "PUT",
      url:
        request.url ??
        projectSourceUploadPartPath(
          request.mountRef ?? lease.mountRef,
          locator,
        ),
      headers: {
        ...authentication.headers,
        "content-type": request.contentType ?? "application/octet-stream",
        ...(request.contentEncoding
          ? { "content-encoding": request.contentEncoding }
          : {}),
      },
      payload: Buffer.from(bytes),
    });
  async function writePart(
    locator: ProjectSourceUploadPartLocator,
    bytes: Uint8Array,
  ) {
    const response = await partRaw(locator, bytes);
    assert.equal(response.statusCode, 200, response.body);
    return parseProjectSourceUploadPartResponse(
      response.json(),
      locator,
      bytes.byteLength,
    );
  }

  return {
    f,
    state,
    projects,
    installed,
    enabled,
    foundation,
    authority,
    authentication,
    app,
    lease,
    invoke,
    invokeRaw,
    uploads,
    invokeUpload,
    partRaw,
    writePart,
  };
}

async function writableTree(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  await chmod(path, 0o700);
  for (const name of await readdir(path)) await writableTree(join(path, name));
}
