import { randomBytes } from "node:crypto";
import { bindDesktopNativeProjectWorkspaceRuntime } from "./desktopNativeProjectWorkspaceRuntime.ts";
import {
  bindDesktopNativePluginBusinessActivation,
  bindDesktopNativePluginPreparationBusinessActivation,
} from "./desktopNativePluginBusinessActivation.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspect, isDeepStrictEqual } from "node:util";
import {
  parseNativeInstalledPluginPreparationResult,
  NATIVE_INSTALLED_PLUGIN_PREPARATION_RESULT_MAX_BYTES,
} from "@crewon/contracts/plugins";
import {
  assertDesktopPluginBootstrapIssued,
  type DesktopPluginBootstrap,
} from "./desktopPluginBootstrap.ts";
import type { ActiveProvider } from "./providerCredentials.ts";
import {
  captureDesktopInstalledPluginRuntimeDocument as capture,
  desktopInstalledPluginInvalid as invalid,
  desktopInstalledPluginRecord as record,
  type DesktopInstalledPluginProviderBinding,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";
import {
  captureDesktopNativePluginPolicy,
  createDesktopNativePluginAuthority,
} from "./desktopNativePluginAuthority.ts";
import { createDesktopInstalledPluginPreparationFiles } from "./desktopInstalledPluginPreparationFiles.ts";
import { captureDesktopInstalledPluginRelease } from "./desktopInstalledPluginReleaseCapture.ts";
import { desktopInstalledPluginModelCatalog } from "./desktopInstalledPluginModelCatalog.ts";
import {
  withoutDesktopInstalledPluginEnvironment,
  type DesktopInstalledPluginRuntime,
} from "./desktopInstalledPluginRuntime.ts";
import type {
  AutomaticDesktopInstalledPluginRuntime,
  AutomaticDesktopInstalledPluginRuntimeCompletion,
} from "./desktopAutomaticInstalledPluginRuntime.ts";

/** Native local execution has its own explicit policy; remote paid runtime contracts remain unchanged. */
export function prepareNativeDesktopInstalledPluginRuntime(
  input: Readonly<{
    dataDirectory: string;
    bootstrap: DesktopPluginBootstrap;
    provider: ActiveProvider;
    sharedEnvironment: NodeJS.ProcessEnv;
    workerEnvironment: NodeJS.ProcessEnv;
    signal: AbortSignal;
    deadlineMs?: number;
  }>,
): AutomaticDesktopInstalledPluginRuntime | null {
  const policy = captureDesktopNativePluginPolicy(
    input.dataDirectory,
    input.bootstrap,
  );
  if (policy === null) return null;
  const { signal, bootstrap, provider } = input;
  signal.throwIfAborted();
  const manifest = assertDesktopPluginBootstrapIssued(bootstrap);
  const shared: NodeJS.ProcessEnv = {
      ...withoutDesktopInstalledPluginEnvironment(input.sharedEnvironment),
      CREWON_MODEL_CREDENTIAL_REQUIRED: provider.apiKey === null ? "0" : "1",
    },
    worker: NodeJS.ProcessEnv = {
      ...withoutDesktopInstalledPluginEnvironment(input.workerEnvironment),
      CREWON_MODEL_CREDENTIAL_REQUIRED: provider.apiKey === null ? "0" : "1",
    };
  const providerBinding: DesktopInstalledPluginProviderBinding = {
    providerId: provider.providerId,
    endpoint: provider.endpoint,
    responsesEndpoint: shared.CREWON_RESPONSES_ENDPOINT!,
    modelId: provider.modelId,
    credentialRequired: provider.apiKey !== null,
  };
  const modelCatalog = desktopInstalledPluginModelCatalog(
    shared,
    provider.modelId,
  );
  if (
    shared.CREWON_CONTROL_DB_PATH !==
      join(input.dataDirectory, "control.sqlite") ||
    shared.CREWON_CONTROL_SECURITY_MODE !== "standalone" ||
    shared.CREWON_MODEL_ID !== provider.modelId ||
    [
      "CREWON_PRINCIPAL_ID",
      "CREWON_ACTOR_ID",
      "CREWON_TENANT_ID",
      "CREWON_SPACE_ID",
    ].some(
      (key, index) =>
        shared[key] !==
          [
            manifest.actor.principalId,
            manifest.actor.actorId,
            manifest.actor.tenantId,
            manifest.actor.spaceId,
          ][index] || worker[key] !== shared[key],
    ) ||
    worker.CREWON_MODEL_API_KEY !== (provider.apiKey ?? "") ||
    worker.CREWON_MODEL_CATALOG_JSON !== shared.CREWON_MODEL_CATALOG_JSON
  )
    invalid("native_environment");
  const deadlineMs = input.deadlineMs ?? 20000;
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1000 ||
    deadlineMs > 30000
  )
    invalid("deadline");
  const authority = createDesktopNativePluginAuthority({
    dataDirectory: input.dataDirectory,
    bootstrap,
    policy,
  });
  // Package approvals retain historical versions, while preparation has one
  // entry per plugin. A retained version can never weaken per-action approval.
  const requirements = new Map<string, "none" | "perAction">();
  for (const { pluginId, approvalRequirement } of policy.packages)
    requirements.set(
      pluginId,
      requirements.get(pluginId) === "perAction"
        ? "perAction"
        : approvalRequirement,
    );
  const plugins = [...requirements].map(([pluginId, approvalRequirement]) => ({
    pluginId,
    approvalRequirement,
  }));
  let files: ReturnType<typeof createDesktopInstalledPluginPreparationFiles>;
  try {
    files = createDesktopInstalledPluginPreparationFiles({
      dataDirectory: input.dataDirectory,
      buildDocuments: ({ workerPath, releasePath }) => ({
        preparation: {
          schemaVersion: "crewon.installed-plugin-native-preparation.v2",
          actor: manifest.actor,
          scope: manifest.scope,
          approvedPackages: authority.authority.packages,
          plugins,
          workerConfigurationPath: workerPath,
        },
        worker: {
          schemaVersion: "crewon.installed-plugin-native-worker.v1",
          installRoot: manifest.installRoot,
          releaseDocumentPath: releasePath,
          nativeAuthorityPath: authority.path,
          historicalScope: null,
          timeoutMs: deadlineMs,
        },
      }),
    });
  } catch (error) {
    authority.close();
    throw error;
  }
  let withdrawn = false,
    closed = false,
    token = randomBytes(32).toString("hex");
  let complete: AutomaticDesktopInstalledPluginRuntimeCompletion | null = null;
  const snapshots: { assertCurrent(): void }[] = [];
  let controlFile: ReturnType<typeof capture> | null = null;
  let peerOrigin: string | null = null;
  let closing: Promise<void> | null = null;
  const assertCurrent = () => {
    if (withdrawn || closed) invalid("withdrawn");
    signal.throwIfAborted();
    authority.assertCurrent();
    files.assertCurrent();
    if (assertDesktopPluginBootstrapIssued(bootstrap) !== manifest)
      invalid("bootstrap_changed");
    for (const snapshot of snapshots) snapshot.assertCurrent();
    controlFile?.assertCurrent();
  };
  const withdraw = () => {
    withdrawn = true;
    authority.withdraw();
    files.withdraw();
  };
  signal.addEventListener("abort", withdraw, { once: true });
  const execution = (env: NodeJS.ProcessEnv) =>
    Object.freeze({
      ...env,
      CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH: files.workerPath,
    });
  const owner: AutomaticDesktopInstalledPluginRuntime = {
    get preparationEnvironment() {
      assertCurrent();
      return Object.freeze({
        ...shared,
        CREWON_INSTALLED_PLUGIN_NATIVE_PREPARATION_PATH: files.preparationPath,
      });
    },
    assertCurrent,
    withdraw,
    complete() {
      assertCurrent();
      if (complete) return complete;
      const resultFile = capture(
          files.resultPath,
          NATIVE_INSTALLED_PLUGIN_PREPARATION_RESULT_MAX_BYTES,
        ),
        result = parseNativeInstalledPluginPreparationResult(resultFile.value);
      snapshots.push(resultFile);
      if (
        !isDeepStrictEqual(result.actor, manifest.actor) ||
        !isDeepStrictEqual(result.scope, manifest.scope) ||
        result.defaultAgentVersionId !== shared.CREWON_AGENT_VERSION_ID ||
        result.plugins.length !== plugins.length ||
        result.plugins.some(
          (status, index) => status.pluginId !== plugins[index]!.pluginId,
        )
      )
        invalid("preparation_result");
      if (!result.plugins.some((status) => status.state === "prepared")) {
        files.assertReleaseAbsent();
        complete = Object.freeze({
          kind: "default",
          environments: Object.freeze({
            sharedEnvironment: Object.freeze({ ...shared }),
            workerEnvironment: Object.freeze({ ...worker }),
          }),
          statuses: result.plugins,
        });
        return complete;
      }
      const release = capture(files.releasePath, 1024 * 1024);
      snapshots.push(release);
      const expectedCatalogEntries = captureDesktopInstalledPluginRelease(
        release.value,
        manifest,
        shared,
        { providerBinding, modelCatalog },
        {},
        snapshots,
      );
      const doc = record(release.value);
      const seenPlugins = new Set<string>();
      const defaultTargets = new Set<string>();
      for (const raw of doc.entries as unknown[]) {
        const entry = record(raw),
          identity = record(entry.packageIdentity),
          config = record(entry.configuration);
        const status = result.plugins.find(
          (item) => item.pluginId === identity.pluginId,
        );
        if (
          status?.state !== "prepared" ||
          !isDeepStrictEqual(status.packageIdentity, identity) ||
          !isDeepStrictEqual(status.configuration, {
            revision: config.revision,
            contentDigest: config.contentDigest,
          }) ||
          status.approvalRequirement !== entry.approvalRequirement
        )
          invalid("preparation_output");
        // The first published sibling is the prepared default. Other targets were
        // independently checked against Main's model catalog above.
        if (
          !seenPlugins.has(status.pluginId) &&
          !isDeepStrictEqual(status.target, entry.target)
        )
          invalid("preparation_output");
        seenPlugins.add(status.pluginId);
        if (isDeepStrictEqual(status.target, entry.target))
          defaultTargets.add(status.pluginId);
      }
      if (
        defaultTargets.size !==
        result.plugins.filter((status) => status.state === "prepared").length
      )
        invalid("preparation_output");
      const runtime: DesktopInstalledPluginRuntime = Object.freeze({
        get release() {
          assertCurrent();
          return execution(shared);
        },
        get worker() {
          assertCurrent();
          return Object.freeze({
            ...execution(worker),
            CREWON_INSTALLED_PLUGIN_PEER_PORT: "0",
            CREWON_INSTALLED_PLUGIN_PEER_TOKEN: token,
            CREWON_INSTALLED_PLUGIN_PEER_DEADLINE_MS: String(deadlineMs),
          });
        },
        get control() {
          assertCurrent();
          return Object.freeze({ ...shared });
        },
        controlAfterPeer({ origin }) {
          assertCurrent();
          if (
            !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(origin) ||
            Number(new URL(origin).port) > 65535
          )
            invalid("native_peer");
          if (peerOrigin !== null && peerOrigin !== origin)
            invalid("native_peer_changed");
          const path = join(files.directory, "native-control.json");
          if (controlFile === null) {
            writeFileSync(
              path,
              JSON.stringify({
                schemaVersion: "crewon.desktop-native-plugin-control.v2",
                authorityPath: authority.path,
                peer: {
                  origin,
                  tokenEnvironmentVariable:
                    "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN",
                },
                entries: expectedCatalogEntries,
              }),
              { mode: 0o600, flag: "wx" },
            );
            controlFile = capture(path, 128 * 1024);
            peerOrigin = origin;
          }
          assertCurrent();
          return Object.freeze({
            ...shared,
            CREWON_DESKTOP_NATIVE_PLUGIN_CONTROL_PATH: path,
            CREWON_DESKTOP_NATIVE_PLUGIN_AUTHORITY_PATH: authority.path,
            CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN: token,
          });
        },
        get token() {
          assertCurrent();
          return token;
        },
        scope: manifest.scope,
        expectedCatalogEntries,
        assertCurrent,
        withdraw,
        async close() {
          withdraw();
        },
      });
      bindDesktopNativePluginBusinessActivation(
        runtime,
        authority.authority.packages,
      );
      bindDesktopNativeProjectWorkspaceRuntime({
        owner: runtime,
        nativeAuthority: authority,
        assertCurrent,
      });
      complete = Object.freeze({
        kind: "installed",
        runtime,
        statuses: result.plugins,
      });
      assertCurrent();
      return complete;
    },
    close() {
      withdraw();
      return (closing ??= (async () => {
        signal.removeEventListener("abort", withdraw);
        files.close();
        authority.close();
        token = "";
        closed = true;
      })());
    },
  };
  Object.defineProperties(owner, {
    toJSON: {
      value: () => ({ withdrawn, closed, completion: complete?.kind ?? null }),
    },
    [inspect.custom]: { value: () => "[NativeDesktopInstalledPluginRuntime]" },
  });
  assertCurrent();
  bindDesktopNativePluginPreparationBusinessActivation(
    owner,
    authority.authority.packages,
  );
  return Object.freeze(owner);
}
