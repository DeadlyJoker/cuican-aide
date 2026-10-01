// @vitest-environment node
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseExtensionHostRequest,
  type ExtensionHostRequest,
} from "@crewon/contracts";
import {
  createExtensionConfiguration,
  parseExtensionExecutionTarget,
} from "@crewon/domain";
import {
  extensionRecoveryDirectory,
  putExtensionRecoveryFile,
  resolveExtensionRecoveryCapsule,
  writeExtensionRecoveryStartupReport,
  type ExtensionRecoveryFilePin,
  type ExtensionRecoveryInputFile,
  type ExtensionRecoveryManifest,
} from "@crewon/agent-version/extension-recovery";
import {
  completeDesktopExtensionRecovery,
  desktopExtensionRecoveryAttempt,
  loadDesktopExtensionRecovery,
} from "./desktopExtensionRecovery.ts";
import {
  DESKTOP_RUNTIME_OWNER,
  desktopExtensionRuntimeEnvironments,
  type DesktopExtensionRuntimeEnvironments,
} from "./desktopExtensionRuntime.ts";

// This unit boundary does not execute an archive or claim a real Worker/build was verified.
// Source and installed-bundle proof belong to the separate actual-process integrations.
const archive = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@crewon/agent-version/extension-build", () => ({
  EXTENSION_HISTORICAL_WORK_ITEM_SCOPE: "crewon.extension-work-item-scope.v1",
  resolveRetainedExtensionBuild: (...args: unknown[]) =>
    archive.resolve(...args),
}));
const roots: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
const token = "c".repeat(64);
const provider = {
  providerId: "fixture-provider",
  endpoint: "https://provider.example/v1",
  modelId: "fixture-model",
  apiKey: "private-fixture-model-key",
};
const owner = DESKTOP_RUNTIME_OWNER;
function digest(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
const digester = { sha256: digest };
const registration = {
  pluginId: "crewon.comfyui-krea2",
  pluginVersion: "1.0.0",
  manifestDigest: digest("manifest"),
  implementationDigest: digest("adapter-registration"),
};

beforeEach(() => {
  archive.resolve.mockReset();
  archive.resolve.mockResolvedValue({
    historicalWorkItemScope: "crewon.extension-work-item-scope.v1",
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of cleanup.splice(0)) await close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(
    join(realpathSync(tmpdir()), "crewon-native-recovery-unit-"),
  );
  roots.push(path);
  return path;
}
function environments(enabled = true): DesktopExtensionRuntimeEnvironments {
  return desktopExtensionRuntimeEnvironments({
    configuration: enabled
      ? {
          schemaVersion: "crewon.desktop-extension-runtime.v0",
          enabled: true,
          runtimeBindingsPath: null,
          agentVersionAssetsPath: null,
        }
      : {
          schemaVersion: "crewon.desktop-extension-runtime.v0",
          enabled: false,
        },
    sharedEnvironment: {
      CREWON_RESPONSES_ENDPOINT: "https://provider.example/v1/responses",
      CREWON_MODEL_API_KEY: provider.apiKey,
      CREWON_MODEL_CREDENTIAL_REQUIRED: "1",
    },
    workerEnvironment: { CREWON_MODEL_API_KEY: provider.apiKey },
  });
}
async function fixture(count = 1) {
  const dataRoot = root();
  const initial = environments();
  const requested = desktopExtensionRecoveryAttempt({
    dataRoot,
    provider,
    source: false,
    environments: initial,
  });
  if (requested.attempt === null) throw new Error("fixture_attempt_missing");
  const attempt = requested.attempt;
  const selection = { dataRoot, capsuleId: digest("capsule") };
  const directory = await extensionRecoveryDirectory({
    selection,
    create: true,
  });
  const targets = Array.from({ length: count }, (_, index) =>
    parseExtensionExecutionTarget({
      executionAuthority: "crewonKernel",
      agentVersionId: `prepared-agent-${index}`,
      agentVersionContentDigest: digest(`agent-${index}`),
      materializationDigest: digest(`materialization-${index}`),
      authorityId: "standalone-authority",
      runtimeGeneration: "retained-generation",
      policySnapshotId: "standalone-policy-v0",
      workspaceBindingId: null,
    }),
  );
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: owner.tenantId,
      spaceId: owner.spaceId,
      ...registration,
      revision: 1,
      parameters: { serviceUrl: "https://comfy.example/" },
      credentialBindings: [],
      createdByActorId: owner.actorId,
      createdAt: "2026-10-02T00:00:00.000Z",
    },
    digester,
  );
  const documents = new Map<ExtensionRecoveryInputFile, unknown>([
    [
      "plugin-bindings.json",
      {
        schemaVersion: "crewon.agent-version-runtime-bindings.v0",
        bindings: targets.map((target, index) => ({
          agentVersionId: target.agentVersionId,
          provider: {
            kind: "directResponses",
            endpoint: attempt.providerBinding.responsesEndpoint,
            apiKeyEnvironment: "CREWON_MODEL_API_KEY",
            credentialRequired: true,
          },
          extensionConfigPath: join(
            directory,
            `snapshot-${String(index).padStart(2, "0")}.json`,
          ),
        })),
      },
    ],
    ["plugin-assets.json", { fixtureMetadata: true }],
    ["base-bindings.json", { fixtureMetadata: true }],
    ["bootstrap.json", { fixtureMetadata: true }],
    ["release.json", { fixtureMetadata: true }],
  ]);
  for (let index = 0; index < count; index++)
    documents.set(`snapshot-${String(index).padStart(2, "0")}.json`, {
      schemaVersion: "crewon.extension-runtime-config.v0",
      configuration,
      approvalRequirement: "none",
    });
  const files: ExtensionRecoveryFilePin[] = [];
  for (const [file, document] of documents)
    files.push(
      await putExtensionRecoveryFile({
        selection,
        file,
        bytes: Buffer.from(JSON.stringify(document)),
      }),
    );
  const manifest: ExtensionRecoveryManifest = {
    schemaVersion: "crewon.extension-recovery-capsule.v0",
    capsuleId: selection.capsuleId,
    owner,
    implementationDigest: digest("source-metadata-unit-boundary"),
    buildIdentityDigest: digest("build-metadata-unit-boundary"),
    providerBinding: attempt.providerBinding,
    releaseId: "release-fixture",
    registrations: [registration],
    targets,
    files,
  };
  return {
    dataRoot,
    directory,
    attempt,
    environments: requested.environments,
    selection,
    manifest,
    configuration,
    documents,
  };
}

type PeerMode =
  | "valid"
  | "owner"
  | "registration"
  | "digest"
  | "agent"
  | "target"
  | "not-ready"
  | "unauthorized"
  | "redirect"
  | "content-type"
  | "oversize"
  | "utf8"
  | "hang";
async function peer(
  value: Awaited<ReturnType<typeof fixture>>,
  mode: PeerMode = "valid",
) {
  const calls: ExtensionHostRequest[] = [];
  const errors: unknown[] = [];
  let received!: () => void;
  const requestReceived = new Promise<void>((resolve) => {
    received = resolve;
  });
  const server = createServer(async (request, response) => {
    try {
      expect(request.url).toBe("/private/v0/extensions");
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      let bytes = "";
      for await (const chunk of request) bytes += chunk.toString();
      const body = parseExtensionHostRequest(JSON.parse(bytes));
      calls.push(body);
      received();
      if (body.operation !== "readiness")
        throw new Error("fixture_operation_invalid");
      const expected = value.manifest.targets.find(
        (target) => target.agentVersionId === body.agentVersionId,
      );
      if (!expected) throw new Error("fixture_agent_invalid");
      if (mode === "unauthorized") {
        response.writeHead(401);
        response.end();
        return;
      }
      if (mode === "redirect") {
        response.writeHead(302, { location: "/redirected" });
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-type":
          mode === "content-type" ? "text/plain" : "application/json",
      });
      if (mode === "hang") {
        response.write("{");
        return;
      }
      if (mode === "oversize") {
        response.end(" ".repeat(128 * 1024 + 1));
        return;
      }
      if (mode === "utf8") {
        response.end(Buffer.from([0xff, 0xff]));
        return;
      }
      response.end(
        JSON.stringify({
          protocol: "crewon.extension-host-response.v0",
          operation: "readiness",
          actor:
            mode === "owner"
              ? { ...body.actor, principalId: "substituted-principal" }
              : body.actor,
          registration:
            mode === "registration"
              ? { ...body.registration, pluginVersion: "9.0.0" }
              : body.registration,
          configurationDigest:
            mode === "digest"
              ? digest("wrong")
              : (body.configuration as { contentDigest: string }).contentDigest,
          agentVersionId:
            mode === "agent" ? "different-agent" : body.agentVersionId,
          result:
            mode === "not-ready"
              ? {
                  outcome: "unavailable",
                  reasonCode: "extension_runtime_unavailable",
                }
              : {
                  outcome: "ready",
                  target:
                    mode === "target"
                      ? {
                          ...expected,
                          materializationDigest: digest(
                            "wrong-materialization",
                          ),
                        }
                      : expected,
                },
        }),
      );
    } catch (error) {
      errors.push(error);
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture_address_invalid");
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return {
    origin: `http://127.0.0.1:${address.port}`,
    calls,
    errors,
    requestReceived,
  };
}
function complete(
  value: Awaited<ReturnType<typeof fixture>>,
  origin: string,
  options: Partial<Parameters<typeof completeDesktopExtensionRecovery>[0]> = {},
) {
  return completeDesktopExtensionRecovery({
    dataRoot: value.dataRoot,
    manifest: value.manifest,
    origin,
    token,
    signal: new AbortController().signal,
    deadlineMs: 2000,
    ...options,
  });
}

describe("Native recovery producer behavior (archive lookup is a unit port)", () => {
  it("preserves disabled/source startup and gives installed enabled attempts fresh nonsecret identity", () => {
    const dataRoot = root();
    for (const [source, environment] of [
      [false, environments(false)],
      [true, environments()],
    ] as const) {
      const result = desktopExtensionRecoveryAttempt({
        dataRoot,
        provider,
        source,
        environments: environment,
      });
      expect(result.attempt).toBeNull();
      expect(result.environments).toBe(environment);
    }
    const environment = environments();
    const first = desktopExtensionRecoveryAttempt({
      dataRoot,
      provider,
      source: false,
      environments: environment,
    });
    const second = desktopExtensionRecoveryAttempt({
      dataRoot,
      provider,
      source: false,
      environments: environment,
    });
    expect(first.attempt?.attemptId).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.attempt?.attemptId).not.toBe(second.attempt?.attemptId);
    expect(Object.isFrozen(first.attempt)).toBe(true);
    expect(
      first.environments.release.CREWON_EXTENSION_RECOVERY_ATTEMPT_ID,
    ).toBe(first.attempt?.attemptId);
    expect(JSON.stringify(first.attempt)).not.toContain(provider.apiKey);
    expect(
      first.environments.release.CREWON_EXTENSION_RECOVERY_PROVIDER_JSON,
    ).not.toContain(provider.apiKey);
    expect(first.environments.worker).toBe(environment.worker);
    expect(first.environments.control).toBe(environment.control);
    expect(
      environment.release.CREWON_EXTENSION_RECOVERY_ATTEMPT_ID,
    ).toBeUndefined();
  });

  it("unsupported provider recovery inputs preserve current environments", () => {
    const environment = environments();
    environment.release.CREWON_RESPONSES_ENDPOINT =
      "https://other.example/responses";
    const result = desktopExtensionRecoveryAttempt({
      dataRoot: root(),
      provider,
      source: false,
      environments: environment,
    });
    expect(result.attempt).toBeNull();
    expect(result.environments).toBe(environment);
  });

  it("loads only the exact fresh report, owner, provider and pinned plugin documents", async () => {
    const value = await fixture();
    await writeExtensionRecoveryStartupReport({
      dataRoot: value.dataRoot,
      report: {
        schemaVersion: "crewon.extension-recovery-startup.v0",
        attemptId: value.attempt.attemptId,
        outcome: "prepared",
        manifest: value.manifest,
      },
    });
    const loaded = await loadDesktopExtensionRecovery({
      attempt: value.attempt,
      environments: value.environments,
    });
    expect(loaded.candidate).toEqual(value.manifest);
    expect(
      loaded.environments.worker.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH,
    ).toBe(join(value.directory, "plugin-bindings.json"));
    expect(
      loaded.environments.worker.CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH,
    ).toBe(join(value.directory, "plugin-assets.json"));
    expect(loaded.environments.release).toEqual(value.environments.release);
    expect(loaded.environments.control).toBe(value.environments.control);
    expect(existsSync(join(value.directory, "manifest.json"))).toBe(false);
    for (const field of [
      "principalId",
      "actorId",
      "tenantId",
      "spaceId",
    ] as const) {
      const manifest = {
        ...value.manifest,
        owner: { ...owner, [field]: "different-owner" },
      };
      await writeExtensionRecoveryStartupReport({
        dataRoot: value.dataRoot,
        report: {
          schemaVersion: "crewon.extension-recovery-startup.v0",
          attemptId: value.attempt.attemptId,
          outcome: "prepared",
          manifest,
        },
      });
      await expect(
        loadDesktopExtensionRecovery({
          attempt: value.attempt,
          environments: value.environments,
        }),
      ).rejects.toThrow("desktop_extension_recovery_unavailable");
    }
    await expect(
      loadDesktopExtensionRecovery({
        attempt: { ...value.attempt, attemptId: "f".repeat(64) },
        environments: value.environments,
      }),
    ).rejects.toThrow("extension_recovery_startup_attempt_mismatch");
  });

  it.each([
    "extension_recovery_current_provider_mismatch",
    "extension_recovery_current_credential_unavailable",
  ] as const)(
    "clears only plugin paths for the explicit %s startup result",
    async (reasonCode) => {
      const value = await fixture();
      const environment = {
        ...value.environments,
        release: { ...value.environments.release },
        worker: { ...value.environments.worker },
      };
      for (const role of [environment.release, environment.worker]) {
        role.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH = join(
          value.directory,
          "plugin-bindings.json",
        );
        role.CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH = join(
          value.directory,
          "plugin-assets.json",
        );
        role.CREWON_AGENT_VERSION_ID = "current-default-agent";
      }
      await writeExtensionRecoveryStartupReport({
        dataRoot: value.dataRoot,
        report: {
          schemaVersion: "crewon.extension-recovery-startup.v0",
          attemptId: value.attempt.attemptId,
          outcome: "pluginUnavailable",
          reasonCode,
        },
      });
      rmSync(value.directory, { recursive: true });
      const result = await loadDesktopExtensionRecovery({
        attempt: value.attempt,
        environments: environment,
      });
      expect(result.candidate).toBeNull();
      expect(result.reasonCode).toBe(reasonCode);
      expect(result.environments.enabled).toBe(true);
      for (const role of [
        result.environments.release,
        result.environments.worker,
      ]) {
        expect(role.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH).toBeUndefined();
        expect(role.CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH).toBeUndefined();
        expect(role.CREWON_AGENT_VERSION_ID).toBe("current-default-agent");
        expect(role.CREWON_MODEL_API_KEY).toBe(provider.apiKey);
      }
      expect(result.environments.worker.CREWON_EXTENSION_HOST_TOKEN).toBe(
        environment.worker.CREWON_EXTENSION_HOST_TOKEN,
      );
      expect(result.environments.control).toBe(environment.control);
      expect(
        environment.release.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH,
      ).toBeDefined();
      expect(
        environment.worker.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH,
      ).toBeDefined();
      expect(existsSync(value.directory)).toBe(false);
    },
  );

  it.each(["provider-id", "credential-required"] as const)(
    "keeps published paths but omits a recovery candidate for same-endpoint %s changes",
    async (mode) => {
      const value = await fixture();
      const manifest = {
        ...value.manifest,
        providerBinding: {
          ...value.manifest.providerBinding,
          ...(mode === "provider-id"
            ? { providerId: "previous-provider-id" }
            : { credentialRequired: false }),
        },
      };
      await writeExtensionRecoveryStartupReport({
        dataRoot: value.dataRoot,
        report: {
          schemaVersion: "crewon.extension-recovery-startup.v0",
          attemptId: value.attempt.attemptId,
          outcome: "prepared",
          manifest,
        },
      });
      const result = await loadDesktopExtensionRecovery({
        attempt: value.attempt,
        environments: value.environments,
      });
      expect(result.candidate).toBeNull();
      expect(result.reasonCode).toBe("extension_recovery_provider_mismatch");
      expect(
        result.environments.worker.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH,
      ).toBe(join(value.directory, "plugin-bindings.json"));
      expect(
        result.environments.worker.CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH,
      ).toBe(join(value.directory, "plugin-assets.json"));
      expect(result.environments.worker.CREWON_MODEL_API_KEY).toBe(
        provider.apiKey,
      );
      expect(existsSync(join(value.directory, "manifest.json"))).toBe(false);
    },
  );

  it.each(["endpoint", "credential", "both"] as const)(
    "omits frozen plugin inputs for %s current-key routing incompatibility",
    async (mode) => {
      const value = await fixture();
      const document = structuredClone(
        value.documents.get("plugin-bindings.json"),
      ) as { bindings: Array<{ provider: { endpoint: string } }> };
      if (mode === "endpoint" || mode === "both")
        document.bindings[0]!.provider.endpoint =
          "https://previous-provider.example/v1/responses";
      const bytes = Buffer.from(JSON.stringify(document));
      writeFileSync(join(value.directory, "plugin-bindings.json"), bytes);
      const manifest = {
        ...value.manifest,
        files: value.manifest.files.map((pin) =>
          pin.file === "plugin-bindings.json"
            ? { ...pin, digest: digest(bytes.toString()) }
            : pin,
        ),
      };
      await writeExtensionRecoveryStartupReport({
        dataRoot: value.dataRoot,
        report: {
          schemaVersion: "crewon.extension-recovery-startup.v0",
          attemptId: value.attempt.attemptId,
          outcome: "prepared",
          manifest,
        },
      });
      const environment = {
        ...value.environments,
        release: { ...value.environments.release },
        worker: { ...value.environments.worker },
      };
      for (const role of [environment.release, environment.worker]) {
        role.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH = join(
          value.directory,
          "previous-bindings.json",
        );
        role.CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH = join(
          value.directory,
          "previous-assets.json",
        );
        role.CREWON_AGENT_VERSION_ID = "current-default-agent";
      }
      if (mode === "credential" || mode === "both")
        environment.worker.CREWON_MODEL_API_KEY = " ";
      const result = await loadDesktopExtensionRecovery({
        attempt: value.attempt,
        environments: environment,
      });
      expect(result.candidate).toBeNull();
      expect(result.reasonCode).toBe(
        mode === "credential"
          ? "extension_recovery_current_credential_unavailable"
          : "extension_recovery_current_provider_mismatch",
      );
      for (const role of [
        result.environments.release,
        result.environments.worker,
      ]) {
        expect(role.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH).toBeUndefined();
        expect(role.CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH).toBeUndefined();
        expect(role.CREWON_AGENT_VERSION_ID).toBe("current-default-agent");
      }
      expect(result.environments.worker.CREWON_MODEL_API_KEY).toBe(
        environment.worker.CREWON_MODEL_API_KEY,
      );
      expect(result.environments.release.CREWON_MODEL_API_KEY).toBe(
        provider.apiKey,
      );
      expect(result.environments.control).toBe(environment.control);
      expect(existsSync(join(value.directory, "manifest.json"))).toBe(false);
    },
  );

  it("preserves unsupported startup while using partially published paths only when explicitly reported", async () => {
    const value = await fixture();
    const report = {
      schemaVersion: "crewon.extension-recovery-startup.v0",
      attemptId: value.attempt.attemptId,
      outcome: "unsupported",
      reasonCode: "extension_recovery_workspace_unsupported",
      preparedInputCapsuleId: null,
    } as const;
    await writeExtensionRecoveryStartupReport({
      dataRoot: value.dataRoot,
      report,
    });
    const absent = await loadDesktopExtensionRecovery({
      attempt: value.attempt,
      environments: value.environments,
    });
    expect(absent.environments).toEqual(value.environments);
    expect(absent.candidate).toBeNull();
    await writeExtensionRecoveryStartupReport({
      dataRoot: value.dataRoot,
      report: { ...report, preparedInputCapsuleId: value.selection.capsuleId },
    });
    const partial = await loadDesktopExtensionRecovery({
      attempt: value.attempt,
      environments: value.environments,
    });
    expect(partial.candidate).toBeNull();
    expect(partial.reasonCode).toBe(report.reasonCode);
    expect(
      partial.environments.worker.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH,
    ).toBe(join(value.directory, "plugin-bindings.json"));
    expect(existsSync(join(value.directory, "manifest.json"))).toBe(false);
  });

  it("rejects tampered pinned input bytes before selecting worker paths", async () => {
    const value = await fixture();
    await writeExtensionRecoveryStartupReport({
      dataRoot: value.dataRoot,
      report: {
        schemaVersion: "crewon.extension-recovery-startup.v0",
        attemptId: value.attempt.attemptId,
        outcome: "prepared",
        manifest: value.manifest,
      },
    });
    writeFileSync(
      join(value.directory, "plugin-assets.json"),
      '{"changed":true}',
    );
    await expect(
      loadDesktopExtensionRecovery({
        attempt: value.attempt,
        environments: value.environments,
      }),
    ).rejects.toThrow("extension_recovery_file_mismatch");
    expect(
      value.environments.worker.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH,
    ).toBeUndefined();
  });

  it("copies loader attempt and process environments before reading the startup report", async () => {
    const value = await fixture();
    await writeExtensionRecoveryStartupReport({
      dataRoot: value.dataRoot,
      report: {
        schemaVersion: "crewon.extension-recovery-startup.v0",
        attemptId: value.attempt.attemptId,
        outcome: "prepared",
        manifest: value.manifest,
      },
    });
    const attempt = structuredClone(value.attempt);
    const environment = {
      ...value.environments,
      release: { ...value.environments.release },
      worker: { ...value.environments.worker },
    };
    const loading = loadDesktopExtensionRecovery({
      attempt,
      environments: environment,
    });
    (attempt as { attemptId: string }).attemptId = "f".repeat(64);
    (attempt as { dataRoot: string }).dataRoot = join(
      value.dataRoot,
      "missing",
    );
    (attempt.providerBinding as { providerId: string }).providerId =
      "changed-provider";
    environment.release.CREWON_MODEL_API_KEY = "changed-after-call";
    environment.worker.CREWON_MODEL_API_KEY = "changed-after-call";
    const loaded = await loading;
    expect(loaded.candidate).toEqual(value.manifest);
    expect(loaded.environments.release.CREWON_MODEL_API_KEY).toBe(
      provider.apiKey,
    );
    expect(loaded.environments.worker.CREWON_MODEL_API_KEY).toBe(
      provider.apiKey,
    );
  });

  it.each([
    "duplicate-bindings",
    "snapshot-path",
    "tenant",
    "registration",
  ] as const)(
    "rejects pinned but incompatible %s metadata before private calls",
    async (mode) => {
      const value = await fixture();
      const host = await peer(value);
      const file: ExtensionRecoveryInputFile =
        mode === "duplicate-bindings" || mode === "snapshot-path"
          ? "plugin-bindings.json"
          : "snapshot-00.json";
      const document = structuredClone(value.documents.get(file)) as {
        bindings?: Array<{
          agentVersionId: string;
          extensionConfigPath: string;
        }>;
        configuration?: typeof value.configuration;
      };
      if (mode === "duplicate-bindings")
        document.bindings!.push({ ...document.bindings![0]! });
      if (mode === "snapshot-path")
        document.bindings![0]!.extensionConfigPath = join(
          value.directory,
          "..",
          "outside.json",
        );
      if (mode === "tenant" || mode === "registration") {
        const { contentDigest: _previous, ...current } = value.configuration;
        document.configuration = createExtensionConfiguration(
          {
            ...current,
            ...(mode === "tenant"
              ? { tenantId: "different-tenant" }
              : { implementationDigest: digest("different-registration") }),
          },
          digester,
        );
      }
      const bytes = Buffer.from(JSON.stringify(document));
      writeFileSync(join(value.directory, file), bytes);
      const manifest = {
        ...value.manifest,
        files: value.manifest.files.map((pin) =>
          pin.file === file
            ? { ...pin, digest: digest(bytes.toString()) }
            : pin,
        ),
      };
      expect((await complete(value, host.origin, { manifest })).outcome).toBe(
        "unavailable",
      );
      expect(host.calls).toHaveLength(0);
      expect(existsSync(join(value.directory, "manifest.json"))).toBe(false);
    },
  );

  it("commits unit metadata only after every private target echo matches", async () => {
    const value = await fixture(5);
    const host = await peer(value);
    expect(await complete(value, host.origin)).toEqual({ outcome: "ready" });
    expect(host.errors).toEqual([]);
    expect(host.calls).toHaveLength(5);
    expect(
      host.calls.map((request) =>
        request.operation === "readiness" ? request.agentVersionId : null,
      ),
    ).toEqual(value.manifest.targets.map((target) => target.agentVersionId));
    expect(
      (await resolveExtensionRecoveryCapsule(value.selection)).manifest,
    ).toEqual(value.manifest);
    expect(archive.resolve).toHaveBeenCalledWith({
      dataRoot: value.dataRoot,
      implementationDigest: value.manifest.implementationDigest,
      expectedBuildIdentityDigest: value.manifest.buildIdentityDigest,
    });
  });

  it.each([
    "owner",
    "registration",
    "digest",
    "agent",
    "target",
    "not-ready",
    "unauthorized",
    "redirect",
    "content-type",
    "oversize",
    "utf8",
  ] as const)(
    "rejects private response %s and leaves the capsule partial",
    async (mode) => {
      const value = await fixture();
      const host = await peer(value, mode);
      expect(await complete(value, host.origin)).toEqual({
        outcome: "unavailable",
        reasonCode: "desktop_extension_recovery_unavailable",
      });
      expect(host.errors).toEqual([]);
      expect(host.calls).toHaveLength(1);
      expect(existsSync(join(value.directory, "manifest.json"))).toBe(false);
    },
  );

  it("rejects obsolete archive scope and tampered snapshot before contacting a private peer", async () => {
    const value = await fixture();
    const host = await peer(value);
    archive.resolve.mockResolvedValue({
      historicalWorkItemScope: "crewon.extension-work-item-scope.v0",
    });
    expect((await complete(value, host.origin)).outcome).toBe("unavailable");
    expect(host.calls).toHaveLength(0);
    archive.resolve.mockResolvedValue({
      historicalWorkItemScope: "crewon.extension-work-item-scope.v1",
    });
    writeFileSync(join(value.directory, "snapshot-00.json"), "{}");
    expect((await complete(value, host.origin)).outcome).toBe("unavailable");
    expect(host.calls).toHaveLength(0);
    expect(existsSync(join(value.directory, "manifest.json"))).toBe(false);
  });

  it("cancels in-flight peer reads on caller abort and has a bounded overall deadline", async () => {
    const value = await fixture();
    const host = await peer(value, "hang");
    const controller = new AbortController();
    const pending = complete(value, host.origin, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("fixture-stop");
    await host.requestReceived;
    controller.abort(new Error("fixture-stop"));
    await rejected;
    expect(existsSync(join(value.directory, "manifest.json"))).toBe(false);
    const deadlineHost = await peer(value, "hang");
    const before = performance.now();
    expect(
      (await complete(value, deadlineHost.origin, { deadlineMs: 1000 }))
        .outcome,
    ).toBe("unavailable");
    expect(performance.now() - before).toBeLessThan(2500);
    expect(existsSync(join(value.directory, "manifest.json"))).toBe(false);
  });

  it("snapshots mutable completion inputs before archive await", async () => {
    const value = await fixture();
    const host = await peer(value);
    let resume!: (value: { historicalWorkItemScope: string }) => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    archive.resolve.mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => {
        resume = resolve;
      });
    });
    const input = {
      dataRoot: value.dataRoot,
      manifest: structuredClone(value.manifest),
      origin: host.origin,
      token,
      signal: new AbortController().signal,
      deadlineMs: 2000,
    };
    const pending = completeDesktopExtensionRecovery(input);
    await reached;
    input.dataRoot = join(value.dataRoot, "changed");
    input.origin = "http://127.0.0.1:1";
    input.token = "d".repeat(64);
    input.signal = AbortSignal.abort();
    (input.manifest.owner as { actorId: string }).actorId = "changed";
    (input.manifest.targets[0] as { agentVersionId: string }).agentVersionId =
      "changed";
    resume({ historicalWorkItemScope: "crewon.extension-work-item-scope.v1" });
    expect(await pending).toEqual({ outcome: "ready" });
    expect(host.errors).toEqual([]);
    expect(
      (await resolveExtensionRecoveryCapsule(value.selection)).manifest,
    ).toEqual(value.manifest);
  });

  it("rejects invalid token, endpoint and deadline before touching archive or peer", async () => {
    const value = await fixture();
    const host = await peer(value);
    for (const options of [
      { token: "short" },
      { origin: "http://localhost:8000" },
      { deadlineMs: 999 },
      { deadlineMs: 30001 },
    ])
      expect((await complete(value, host.origin, options)).outcome).toBe(
        "unavailable",
      );
    expect(archive.resolve).not.toHaveBeenCalled();
    expect(host.calls).toHaveLength(0);
    expect(
      readFileSync(join(value.directory, "bootstrap.json"), "utf8"),
    ).not.toContain(provider.apiKey);
  });
});
