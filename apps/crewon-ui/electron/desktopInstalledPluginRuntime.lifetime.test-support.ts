import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { INSTALLED_PLUGIN_PEER_PRIVATE_PATH } from "@crewon/contracts/plugins";
import {
  DESKTOP_INSTALLED_PLUGIN_RUNTIME_FILE,
  DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";
import {
  closeNativeProcessFixture,
  nativeBootstrapFiles,
  nativeInstalledProcessFixture,
  nativeProcessHttp,
} from "./desktopInstalledPluginRuntime.process.test-support.ts";
import { prepareNativeInstalledProcessRelease } from "./desktopInstalledPluginRuntime.release.test-support.ts";

/** All records and prerequisites come from the same actual Native HTTP/default process path. */
export async function nativeInstalledLifetimeFixture(packageDirectory: string) {
  const f = await nativeInstalledProcessFixture(
    await realpath(packageDirectory),
  );
  try {
    const source = f.sources[0]!;
    const management = f.supervisor(false);
    await management.start();
    const install = await nativeProcessHttp(
      management.session(),
      "POST",
      "/api/v1/plugins/installations",
      {
        sourceId: source.sourceId,
        expectedPluginId: source.pluginId,
        expectedPackageDigest: source.packageDigest,
        expectedSelectionRevision: null,
      },
      "native-lifetime-install",
    );
    assert.equal(install.status, 200, await install.clone().text());
    assert.equal((await install.json()).selection.state, "disabled");
    const saved = await nativeProcessHttp(
      management.session(),
      "PUT",
      `/api/v1/extensions/${source.pluginId}/configuration`,
      {
        pluginVersion: source.version,
        expectedRevision: 0,
        parameters: {
          organization: "Native physical close acceptance",
          providerBaseUrl: `${f.provider.endpoint.split("/v1")[0]}/supplier/`,
        },
        credentialBindings: [],
      },
      "native-lifetime-save",
    );
    assert.equal(saved.status, 200, await saved.clone().text());
    const configuration = (await saved.json()).configuration;
    await management.stop();
    const ordinary = f.supervisor(true);
    await ordinary.start();
    await ordinary.stop();
    const scope = await f.currentProfile();
    assert.ok(scope);
    const { sourceId: _id, directory: _directory, ...identity } = source;
    const prepared = await prepareNativeInstalledProcessRelease({
      dataDirectory: f.dataDirectory,
      scope,
      identity,
      configuration,
      environment: await f.releaseEnvironment(),
    });
    const workerPath = join(f.dataDirectory, "native-lifetime-worker.json");
    await writeFile(
      workerPath,
      JSON.stringify(f.workerConfiguration(prepared.path, scope)),
      { mode: 0o600 },
    );
    await writeFile(
      join(f.dataDirectory, DESKTOP_INSTALLED_PLUGIN_RUNTIME_FILE),
      JSON.stringify({
        schemaVersion: DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
        enabled: true,
        workerConfigurationPath: workerPath,
        providerBinding: {
          providerId: f.provider.providerId,
          endpoint: f.provider.endpoint,
          responsesEndpoint: `${f.provider.endpoint}/responses`,
          modelId: f.provider.modelId,
          credentialRequired: true,
        },
      }),
      { mode: 0o600 },
    );
    assert.deepEqual(await nativeBootstrapFiles(f.dataDirectory), []);
    return f;
  } catch (error) {
    await closeNativeProcessFixture(f, { error });
    throw error;
  }
}

/** Delays delivery of one original HTTP Response. It does not replace request bytes,
 * the real peer service, response/body, authorization or publication. */
export function holdActualNativeCatalogResponse() {
  const original = globalThis.fetch;
  let enter!: (value: { status: number; hasBody: boolean }) => void;
  const entered = new Promise<{ status: number; hasBody: boolean }>(
    (resolve) => {
      enter = resolve;
    },
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let captured = false;
  globalThis.fetch = async (input, init) => {
    const response = await original(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      !captured &&
      url.hostname === "127.0.0.1" &&
      url.pathname === INSTALLED_PLUGIN_PEER_PRIVATE_PATH
    ) {
      captured = true;
      enter({ status: response.status, hasBody: response.body !== null });
      await held;
    }
    return response;
  };
  return {
    entered,
    release,
    restore() {
      globalThis.fetch = original;
    },
  };
}

export async function waitNativeChildClosed(pid: number) {
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH")
        return;
      throw error;
    }
    assert.ok(
      Date.now() < deadline,
      "the actual challenged Worker must physically exit before testing the retained startup join",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
