// @vitest-environment node
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Writable } from "node:stream";
import { expect, it, vi } from "vitest";
import {
  listExtensionRecoveryCapsules,
  type ResolvedExtensionRecoveryCapsule,
} from "@crewon/agent-version/extension-recovery";
import type {
  ExtensionActivationMutationResponse,
  ExtensionCatalogResponse,
  ExtensionConfigurationMutationResponse,
  ExtensionRuntimeResponse,
  ExtensionTaskMutationResponse,
  GetExtensionActivationResponse,
  GetExtensionConfigurationResponse,
  GetExtensionTaskResponse,
  StartTurnResponse,
  ThreadMutationResponse,
} from "@crewon/contracts";
import { parseExtensionConfiguration } from "@crewon/domain";
import {
  command,
  installAndVerifyWorkspace,
  snapshotSources,
  stagedIdentity,
} from "../../../scripts/extension-build-upgrade.test-support.mts";
import { loadDesktopExtensionRuntimeConfiguration } from "./desktopExtensionRuntime.ts";
import { ProviderCredentialStore } from "./providerCredentials.ts";
import {
  RuntimeSupervisor,
  runtimePaths,
  type ControlRuntimeSession,
} from "./runtimeSupervisor.ts";
import {
  eventually,
  instrumentUpgradeFixtureNetwork,
  upgradeAuthoritySnapshot,
  upgradeDefaultText,
  upgradeDigester,
  upgradeJson,
  upgradeProviderFixtures,
  upgradeQueryText,
  upgradeRunBinding,
  upgradeStream,
  upgradeSubmitText,
  writeUpgradeMetadataConfig,
  writeUpgradePlugin,
} from "./desktopExtensionUpgrade.test-support.ts";

const observed = vi.hoisted(() => ({
  children: [] as {
    entry: string;
    child: ChildProcess;
    historical: boolean;
    peers: boolean;
    pluginInputs: boolean;
  }[],
  credentialReads: 0,
}));
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (secret: string) =>
      Buffer.from(`fixture-encrypted:${secret}`),
    decryptString: (bytes: Buffer) => {
      observed.credentialReads++;
      const value = bytes.toString();
      if (!value.startsWith("fixture-encrypted:"))
        throw new Error("fixture_ciphertext_invalid");
      return value.slice("fixture-encrypted:".length);
    },
  },
}));
// Observation only: every call launches the original OS process with unchanged arguments/environment.
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: (...args: Parameters<typeof original.spawn>) => {
      const child = original.spawn(...args);
      const options = args[2] as SpawnOptions | undefined;
      const argv = args[1] as readonly string[] | undefined;
      observed.children.push({
        entry: argv?.at(-1) ?? "",
        child,
        historical:
          options?.env?.CREWON_EXTENSION_EXECUTION_MODE === "historical",
        peers:
          options?.env?.CREWON_EXTENSION_HISTORICAL_HOSTS_JSON !== undefined,
        pluginInputs:
          options?.env?.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH !== undefined ||
          options?.env?.CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH !==
            undefined,
      });
      return child;
    },
  };
});

const oldAgent = "native-upgrade-before-plugin",
  currentAgent = "native-upgrade-current-plugin";
const api = "/api/v1/extensions/crewon.comfyui-krea2";
const secret = "native-upgrade-fixture-keychain-secret";
const live = (child: ChildProcess) =>
  child.exitCode === null && child.signalCode === null;

it("actual Native automatically restores an archived historical build across a genuine seven-bundle upgrade and isolates its process lifetime", async () => {
  expect(process.version).toMatch(/^v24\./u);
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-native-build-upgrade-")),
  );
  const before = join(root, "before"),
    after = join(root, "after"),
    dataRoot = join(root, "native-data");
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 350_000);
  const providers = await upgradeProviderFixtures();
  const logs: string[] = [];
  const logOutput = new Writable({
    write(chunk, _encoding, done) {
      logs.push(String(chunk));
      done();
    },
  });
  let first: RuntimeSupervisor | null = null,
    current: RuntimeSupervisor | null = null;
  observed.children.length = 0;
  observed.credentialReads = 0;
  vi.stubEnv("CREWON_MODEL_CREDENTIAL_REQUIRED", "1");
  vi.stubEnv("CREWON_RESPONSES_STREAM_MAX_RETRIES", "0");
  vi.stubEnv("CREWON_WORKER_SCAN_INTERVAL_MS", "25");
  vi.stubEnv("CREWON_WORKER_RETRY_AFTER_MS", "0");
  vi.stubEnv("CREWON_OUTBOX_SCAN_INTERVAL_MS", "25");
  vi.stubEnv("CREWON_OUTBOX_RETENTION_MS", "off");
  vi.stubEnv("CREWON_ARTIFACT_RETENTION", "off");
  try {
    snapshotSources(before);
    snapshotSources(after);
    for (const copy of [before, after])
      instrumentUpgradeFixtureNetwork(copy, providers.comfyEndpoint);
    // The two controlled copies have identical local-network fixtures. Only this Control change differs.
    const controlPath = join(after, "apps/control-api/src/main.ts");
    const source = readFileSync(controlPath, "utf8"),
      oldMessage = "CrewON Control API listening on 127.0.0.1:",
      newMessage =
        "CrewON Control API listening [native upgrade fixture] on 127.0.0.1:";
    expect(source.split(oldMessage)).toHaveLength(2);
    writeFileSync(controlPath, source.replace(oldMessage, newMessage));
    console.info(
      "Native upgrade: independently installing two offline workspaces and staging two actual seven-bundle builds",
    );
    const beforeDigest = await installAndVerifyWorkspace(before, abort.signal),
      afterDigest = await installAndVerifyWorkspace(after, abort.signal);
    expect(afterDigest).not.toBe(beforeDigest);
    for (const copy of [before, after])
      await command(
        process.execPath,
        [join(copy, "scripts/stage-desktop-runtime.ts")],
        copy,
        abort.signal,
      );
    const firstBuild = stagedIdentity(before),
      currentBuild = stagedIdentity(after);
    expect(firstBuild.identity.implementationDigest).toBe(beforeDigest);
    expect(currentBuild.identity.implementationDigest).toBe(afterDigest);
    expect(
      currentBuild.identity.bundles.find(
        ({ file }) => file === "control-api.mjs",
      )!.digest,
    ).not.toBe(
      firstBuild.identity.bundles.find(
        ({ file }) => file === "control-api.mjs",
      )!.digest,
    );
    const store = new ProviderCredentialStore(dataRoot, async () => {});
    await store.upsert({
      providerId: "native-upgrade-provider",
      endpoint: providers.endpoint,
      modelId: "native-upgrade-model",
      credentialKind: "keychain",
      environmentVariable: null,
      secret,
      activate: true,
    });
    expect(store.catalog().bindings[0]!.credentialAvailable).toBe(true);
    const persistedReader = new ProviderCredentialStore(
      dataRoot,
      async () => {},
    );
    const credentialRequests: unknown[] = [];
    const supervisor = (copy: string) =>
      new RuntimeSupervisor({
        dataDirectory: dataRoot,
        repositoryRoot: copy,
        paths: runtimePaths({
          packaged: true,
          repositoryRoot: copy,
          resourcesPath: join(copy, "apps/crewon-ui/desktop-resources"),
        }),
        provider: () => persistedReader.active(),
        providerModelCatalog: async () => ["native-upgrade-model"],
        agentPlatformApiKeyForOrigin: () => null,
        workspaceRoot: () => null,
        extensionRuntime: {
          configuration: () =>
            loadDesktopExtensionRuntimeConfiguration(dataRoot),
          resolveProviderCredential: (input) => {
            credentialRequests.push({ ...input });
            return persistedReader.resolveForRuntime(input);
          },
        },
        logOutputs: { stdout: logOutput, stderr: logOutput },
      });
    writeUpgradeMetadataConfig(dataRoot);
    first = supervisor(before);
    await first.start();
    const session = first.session();
    const catalog = await upgradeJson<ExtensionCatalogResponse>(
      session,
      "/api/v1/extensions",
    );
    expect(catalog.status, JSON.stringify(catalog.body)).toBe(200);
    expect(catalog.body.extensions).toHaveLength(1);
    const save = async (
      session: ControlRuntimeSession,
      revision: number,
      key: string,
    ) => {
      const result = await upgradeJson<ExtensionConfigurationMutationResponse>(
        session,
        `${api}/configuration`,
        "PUT",
        {
          pluginVersion: catalog.body.extensions[0]!.pluginVersion,
          expectedRevision: revision,
          parameters: { baseUrl: providers.comfyEndpoint },
          credentialBindings: [],
        },
        key,
      );
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      return parseExtensionConfiguration(
        result.body.configuration,
        upgradeDigester,
      );
    };
    const oldConfiguration = await save(session, 0, "before-config");
    const oldOperatorInputs = writeUpgradePlugin(
      dataRoot,
      oldAgent,
      oldConfiguration,
      providers.endpoint,
    );
    const oldDesktopConfigurationBytes = readFileSync(
      oldOperatorInputs.desktopConfigurationPath,
    );
    const operatorFiles = [
      oldOperatorInputs.snapshotPath,
      oldOperatorInputs.runtimeBindingsPath,
      oldOperatorInputs.agentVersionAssetsPath,
    ].map((path) => ({ path, bytes: readFileSync(path) }));
    await first.restart();
    expect(first.session()).toEqual(session);
    const activate = async (
      session: ControlRuntimeSession,
      id: string,
      configurationRevision: number,
      expectedRevision: number,
      key: string,
    ) => {
      const response = await upgradeJson<ExtensionActivationMutationResponse>(
        session,
        `${api}/activation`,
        "PUT",
        {
          state: "enabled",
          agentVersionId: id,
          configurationRevision,
          expectedRevision,
        },
        key,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.activation.target!;
    };
    const oldTarget = await activate(
      session,
      oldAgent,
      oldConfiguration.revision,
      0,
      "before-activate",
    );
    const task = async (
      session: ControlRuntimeSession,
      intent: unknown,
      key: string,
    ) => {
      const thread = await upgradeJson<ThreadMutationResponse>(
        session,
        "/api/v1/threads",
        "POST",
        { title: key },
        `${key}-thread`,
      );
      expect(thread.status, JSON.stringify(thread.body)).toBe(201);
      return upgradeJson<ExtensionTaskMutationResponse>(
        session,
        `${api}/tasks`,
        "POST",
        {
          threadId: thread.body.thread.threadId,
          expectedThreadRevision: thread.body.thread.revision,
          intent,
        },
        key,
      );
    };
    const oldTask = await task(
      session,
      { kind: "generate", input: { prompt: "An old teapot" } },
      "before-generate",
    );
    expect(oldTask.status, JSON.stringify(oldTask.body)).toBe(200);
    expect(await upgradeStream(session, oldTask.body.runId)).toContain(
      upgradeSubmitText,
    );
    const readTask = (session: ControlRuntimeSession, id: string) =>
      upgradeJson<GetExtensionTaskResponse>(session, `${api}/tasks/${id}`);
    const oldView = await readTask(session, oldTask.body.runId);
    expect(oldView.status).toBe(200);
    expect(oldView.body.task.operations).toHaveLength(1);
    expect(oldView.body.task.operations[0]!.status).toBe("submitted");
    const operationId = oldView.body.task.operations[0]!.operationId;
    const originalBinding = upgradeRunBinding(dataRoot, oldTask.body.runId);
    expect(originalBinding.target).toEqual(oldTarget);
    expect(Object.keys(oldTarget)).toHaveLength(8);
    const firstInventory = await listExtensionRecoveryCapsules({ dataRoot });
    expect(firstInventory.unavailable).toEqual([]);
    expect(firstInventory.capsules).toHaveLength(1);
    const oldCapsule = firstInventory.capsules[0]!;
    expect(oldCapsule.manifest.implementationDigest).toBe(beforeDigest);
    expect(oldCapsule.manifest.targets).toEqual([oldTarget]);
    const immutable = oldCapsule.files.map(({ path }) => ({
      path,
      bytes: readFileSync(path),
    }));
    const authorityInput = {
      configurationRevision: oldConfiguration.revision,
      agentVersionId: oldAgent,
      runId: oldTask.body.runId,
    };
    const originalAuthority = upgradeAuthoritySnapshot(
      dataRoot,
      authorityInput,
    );
    expect(JSON.parse(originalAuthority.activationJson).target).toEqual(
      oldTarget,
    );
    await first.stop();
    // The first installed resource tree and its source/dependency workspace are genuinely gone.
    rmSync(before, { recursive: true, force: true });
    expect(existsSync(firstBuild.directory)).toBe(false);
    expect(
      providers.comfyRequests.filter((request) => request === "POST /prompt"),
    ).toHaveLength(1);
    // Keep the operator's A configuration and inputs intact. B must identify and
    // bridge the completed historical inputs without asking the operator to reset.
    expect(readFileSync(oldOperatorInputs.desktopConfigurationPath)).toEqual(
      oldDesktopConfigurationBytes,
    );
    current = supervisor(after);
    const currentRecordStart = observed.children.length;
    await current.start();
    const nextSession = await eventually(
      () => current!.session(),
      () => true,
      "current metadata session",
    );
    await eventually(
      () =>
        observed.children
          .slice(currentRecordStart)
          .filter(
            (record) =>
              record.peers &&
              record.entry ===
                join(currentBuild.directory, "control-api.mjs") &&
              live(record.child),
          ),
      (records) => records.length === 1,
      "automatic old peer Control replacement",
    );
    await eventually(
      () => current!.session(),
      () => true,
      "automatic peer Control health",
    );
    expect(credentialRequests).toContainEqual(
      oldCapsule.manifest.providerBinding,
    );
    const metadataWorker = observed.children.findLast(
      (record) =>
        !record.historical &&
        record.entry === join(currentBuild.directory, "runtime-worker.mjs") &&
        live(record.child),
    );
    expect(metadataWorker).toBeDefined();
    expect(metadataWorker!.pluginInputs).toBe(false);
    expect(readFileSync(oldOperatorInputs.desktopConfigurationPath)).toEqual(
      oldDesktopConfigurationBytes,
    );
    for (const file of operatorFiles)
      expect(readFileSync(file.path)).toEqual(file.bytes);
    for (const file of immutable)
      expect(readFileSync(file.path)).toEqual(file.bytes);
    expect(upgradeAuthoritySnapshot(dataRoot, authorityInput)).toEqual(
      originalAuthority,
    );
    expect(upgradeRunBinding(dataRoot, oldTask.body.runId)).toEqual(
      originalBinding,
    );
    const preservedTask = await readTask(nextSession, oldTask.body.runId);
    expect(preservedTask.status).toBe(200);
    expect(preservedTask.body).toEqual(oldView.body);
    const preservedConfiguration =
      await upgradeJson<GetExtensionConfigurationResponse>(
        nextSession,
        `${api}/configuration?revision=${oldConfiguration.revision}`,
      );
    expect(preservedConfiguration.status).toBe(200);
    expect(preservedConfiguration.body.configuration).toEqual(oldConfiguration);
    const preservedActivation =
      await upgradeJson<GetExtensionActivationResponse>(
        nextSession,
        `${api}/activation`,
      );
    expect(preservedActivation.status).toBe(200);
    expect(preservedActivation.body.activation).toEqual(
      JSON.parse(originalAuthority.activationJson),
    );
    const metadataInventory = await listExtensionRecoveryCapsules({ dataRoot });
    expect(metadataInventory.unavailable).toEqual([]);
    expect(metadataInventory.capsules.map(({ manifest }) => manifest)).toEqual([
      oldCapsule.manifest,
    ]);
    const defaultThread = await upgradeJson<ThreadMutationResponse>(
      nextSession,
      "/api/v1/threads",
      "POST",
      {
        title:
          "Current metadata default preserves the old operator configuration",
      },
      "default-thread",
    );
    const turn = await upgradeJson<StartTurnResponse>(
      nextSession,
      `/api/v1/threads/${defaultThread.body.thread.threadId}/turns`,
      "POST",
      {
        expectedRevision: defaultThread.body.thread.revision,
        content: "Use the current default Agent.",
        agentVersionId: null,
        executionIntent: "none",
      },
      "default-turn",
    );
    expect(turn.status, JSON.stringify(turn.body)).toBe(201);
    expect(await upgradeStream(nextSession, turn.body.run.runId)).toContain(
      upgradeDefaultText,
    );
    expect(providers.modelRequests).toHaveLength(3);
    expect(
      providers.comfyRequests.filter((request) => request === "POST /prompt"),
    ).toHaveLength(1);
    const oldRuntime = await upgradeJson<ExtensionRuntimeResponse>(
      nextSession,
      `${api}/runtime?agentVersionId=${oldAgent}&configurationRevision=${oldConfiguration.revision}`,
    );
    expect(oldRuntime.status).toBe(200);
    expect(oldRuntime.body.readiness.outcome).toBe("unavailable");
    expect(
      (
        await upgradeJson<ExtensionCatalogResponse>(
          nextSession,
          "/api/v1/extensions",
        )
      ).body,
    ).toEqual(catalog.body);
    const queryIntent = {
      kind: "query",
      sourceRunId: oldTask.body.runId,
      operationId,
    };
    const query = await task(nextSession, queryIntent, "historical-query");
    expect(query.status, JSON.stringify(query.body)).toBe(200);
    const queryFrames = await upgradeStream(nextSession, query.body.runId);
    expect(queryFrames).toContain("event: run.completed");
    expect(queryFrames).toContain(upgradeQueryText);
    const queryBinding = upgradeRunBinding(dataRoot, query.body.runId);
    expect(queryBinding.target).toEqual(oldTarget);
    expect(queryBinding.configurationRevision).toBe(oldConfiguration.revision);
    const observedOld = await readTask(nextSession, oldTask.body.runId);
    expect(observedOld.body.task.operations[0]!.status).toBe("succeeded");
    expect(observedOld.body.task.operations[0]!.images[0]!.filename).toBe(
      "native-fixture.png",
    );
    expect(
      providers.comfyRequests.filter((request) => request === "POST /prompt"),
    ).toHaveLength(1);
    expect(
      providers.comfyRequests.filter((request) =>
        request.startsWith("GET /history/"),
      ),
    ).toHaveLength(1);
    expect(upgradeAuthoritySnapshot(dataRoot, authorityInput)).toEqual(
      originalAuthority,
    );
    const metadataModelCount = providers.modelRequests.length;
    const metadataResumed = await upgradeStream(
      nextSession,
      query.body.runId,
      "1",
    );
    expect(metadataResumed).toContain(upgradeQueryText);
    expect(metadataResumed).not.toContain("event: run.created\n");
    expect(providers.modelRequests).toHaveLength(metadataModelCount);
    expect(providers.comfyRequests).toHaveLength(2);
    expect(readFileSync(oldOperatorInputs.desktopConfigurationPath)).toEqual(
      oldDesktopConfigurationBytes,
    );
    const currentConfiguration = await save(
      nextSession,
      oldConfiguration.revision,
      "current-config",
    );
    expect(currentConfiguration.implementationDigest).not.toBe(
      oldConfiguration.implementationDigest,
    );
    writeUpgradePlugin(
      dataRoot,
      currentAgent,
      currentConfiguration,
      providers.endpoint,
    );
    await current.restart();
    expect(current.session()).toEqual(nextSession);
    await eventually(
      () =>
        observed.children.filter(
          (record) => record.historical && live(record.child),
        ),
      (records) => records.length === 1,
      "automatic retained historical host after current publication",
    );
    await eventually(
      () =>
        observed.children.filter(
          (record) =>
            record.peers &&
            record.entry === join(currentBuild.directory, "control-api.mjs") &&
            live(record.child),
        ),
      (records) => records.length === 1,
      "current catalog peer routing ready",
    );
    await eventually(
      () => current!.session(),
      () => true,
      "published current peer Control health",
    );
    const historical = observed.children.find(
      (record) => record.historical && live(record.child),
    )!;
    expect(historical.entry.startsWith(dataRoot + sep)).toBe(true);
    expect(historical.entry).not.toContain(before);
    expect(historical.entry).not.toBe(
      join(currentBuild.directory, "runtime-worker.mjs"),
    );
    const worker = observed.children.findLast(
      (record) =>
        !record.historical &&
        record.entry === join(currentBuild.directory, "runtime-worker.mjs") &&
        live(record.child),
    )!.child;
    expect(
      observed.children.find((record) => record.child === worker)!.pluginInputs,
    ).toBe(true);
    const currentPid = worker.pid;
    expect(currentPid).toBeDefined();
    const currentTarget = await activate(
      nextSession,
      currentAgent,
      currentConfiguration.revision,
      1,
      "current-activate",
    );
    expect(currentTarget).not.toEqual(oldTarget);
    const controlBeforeExit = observed.children.findLast(
      (record) =>
        record.entry === join(currentBuild.directory, "control-api.mjs") &&
        live(record.child),
    )!.child;
    const modelCount = providers.modelRequests.length;
    historical.child.kill("SIGTERM");
    await eventually(
      () => live(historical.child),
      (alive) => !alive,
      "historical process terminal exit",
    );
    const replacement = await eventually(
      () =>
        observed.children.findLast(
          (record) =>
            record.entry === join(currentBuild.directory, "control-api.mjs") &&
            !record.peers &&
            live(record.child),
        ),
      (record) => record !== undefined && record.child !== controlBeforeExit,
      "Control-only peer removal replacement",
    );
    await eventually(
      () => current!.session(),
      () => true,
      "replacement Control health",
    );
    expect(replacement!.child.pid).not.toBe(controlBeforeExit.pid);
    expect(live(controlBeforeExit)).toBe(false);
    expect(live(worker)).toBe(true);
    expect(worker.pid).toBe(currentPid);
    expect(current.session()).toEqual(nextSession);
    const resumed = await upgradeStream(nextSession, query.body.runId, "1");
    expect(resumed).toContain(upgradeQueryText);
    expect(resumed).not.toContain("event: run.created\n");
    const resumedDefault = await upgradeStream(
      nextSession,
      turn.body.run.runId,
      "1",
    );
    expect(resumedDefault).toContain(upgradeDefaultText);
    expect(resumedDefault).not.toContain("event: run.created\n");
    expect(providers.modelRequests).toHaveLength(modelCount);
    expect(
      providers.comfyRequests.filter((request) => request === "POST /prompt"),
    ).toHaveLength(1);
    const noPeer = await task(
      nextSession,
      queryIntent,
      "old-query-after-host-exit",
    );
    expect(noPeer.status, JSON.stringify(noPeer.body)).toBe(409);
    expect(
      (await readTask(nextSession, oldTask.body.runId)).body.task.runStatus,
    ).toBe("completed");
    const newTask = await task(
      nextSession,
      { kind: "generate", input: { prompt: "A current teapot" } },
      "current-generate",
    );
    expect(newTask.status, JSON.stringify(newTask.body)).toBe(200);
    expect(await upgradeStream(nextSession, newTask.body.runId)).toContain(
      upgradeSubmitText,
    );
    expect(upgradeRunBinding(dataRoot, newTask.body.runId).target).toEqual(
      currentTarget,
    );
    const finalInventory = await listExtensionRecoveryCapsules({ dataRoot });
    expect(finalInventory.unavailable).toEqual([]);
    expect(finalInventory.capsules).toHaveLength(2);
    expect(
      finalInventory.capsules.find(
        (capsule) =>
          capsule.manifest.capsuleId === oldCapsule.manifest.capsuleId,
      )?.manifest,
    ).toEqual(oldCapsule.manifest);
    expect(
      finalInventory.capsules.find(
        (capsule) =>
          capsule.manifest.capsuleId !== oldCapsule.manifest.capsuleId,
      )!.manifest.targets,
    ).toEqual([currentTarget]);
    for (const file of immutable)
      expect(readFileSync(file.path)).toEqual(file.bytes);
    for (const file of operatorFiles)
      expect(readFileSync(file.path)).toEqual(file.bytes);
    const finalAuthority = upgradeAuthoritySnapshot(dataRoot, authorityInput);
    expect(finalAuthority.configurationJson).toBe(
      originalAuthority.configurationJson,
    );
    expect(finalAuthority.deploymentJson).toBe(
      originalAuthority.deploymentJson,
    );
    expect(finalAuthority.bindingJson).toBe(originalAuthority.bindingJson);
    expect(upgradeRunBinding(dataRoot, oldTask.body.runId)).toEqual(
      originalBinding,
    );
    expect(JSON.parse(finalAuthority.activationJson).target).toEqual(
      currentTarget,
    );
    for (const capsule of finalInventory.capsules as readonly ResolvedExtensionRecoveryCapsule[])
      for (const { path } of capsule.files)
        expect(readFileSync(path, "utf8")).not.toContain(secret);
    expect(observed.credentialReads).toBeGreaterThan(0);
    expect(
      providers.authorizations.every(
        (authorization) => authorization === `Bearer ${secret}`,
      ),
    ).toBe(true);
    expect(providers.modelRequests).toHaveLength(7);
    expect(
      providers.comfyRequests.filter((request) => request === "POST /prompt"),
    ).toHaveLength(2);
    expect(
      providers.comfyRequests.filter((request) =>
        request.startsWith("GET /history/"),
      ),
    ).toHaveLength(1);
    console.info(
      "Native upgrade evidence: 2 genuine seven-bundle builds; preserved old operator configuration automatically yields current metadata/default plus archived old query; model POST=7, Comfy POST=2, history GET=1; query and SSE reconnect add no generation POST; old capsule/config/deployment/source binding remain unchanged; retained old resources deleted; Control-only replacement preserves current Worker PID",
    );
  } catch (error) {
    console.error(
      logs.join("").slice(-16_000).replaceAll(secret, "[REDACTED]"),
    );
    throw error;
  } finally {
    abort.abort();
    clearTimeout(deadline);
    await Promise.allSettled([first?.stop(), current?.stop()]);
    // Own all fixture processes; await any emergency kill before deleting their files.
    await Promise.allSettled(
      observed.children
        .filter(({ child }) => live(child))
        .map(
          ({ child }) =>
            new Promise<void>((resolve, reject) => {
              const timer = setTimeout(
                () => reject(new Error("native_upgrade_child_cleanup_timeout")),
                10_000,
              );
              child.once("close", () => {
                clearTimeout(timer);
                resolve();
              });
              child.kill("SIGKILL");
            }),
        ),
    );
    try {
      await providers.close();
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 360_000);
