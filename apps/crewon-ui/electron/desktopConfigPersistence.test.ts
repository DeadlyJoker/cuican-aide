import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderCredentialStore } from "./providerCredentials.ts";
import { LocalWorkspaceAuthority } from "./localWorkspace.ts";
import { AgentPlatformCredentialStore } from "./agentPlatformCredentials.ts";

const fault = vi.hoisted(() => ({ rename: false }));
vi.mock("electron", () => ({
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (fault.rename)
        throw Object.assign(new Error("disk_fault"), { code: "ENOSPC" });
      return fs.renameSync(...args);
    },
  };
});

const directories: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "crewon-config-state-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  fault.rename = false;
  vi.unstubAllEnvs();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function provider(providerId: string) {
  return {
    providerId,
    modelId: "model",
    endpoint: "https://example.test/v1",
    credentialKind: "none",
    environmentVariable: null,
    secret: null,
    activate: true,
  };
}

describe("desktop configuration publication follows persistence", () => {
  it("rejects catalog growth beyond the provider reader budget without publishing it", async () => {
    vi.stubEnv("AICUICAN_API_KEY", "");
    const dataDirectory = directory();
    const path = join(dataDirectory, "provider-credentials.json");
    const makeBinding = (index: number) => ({
      providerId: `provider-${index}`,
      endpoint: `https://example.test/${"x".repeat(1_900)}`,
      modelId: "model",
      credentialKind: "none",
      environmentVariable: null,
      encryptedSecret: null,
    });
    const state = {
      schemaVersion: "crewon.provider-credentials.v1",
      activeProviderId: "provider-0",
      bindings: [makeBinding(0)],
    };
    let candidate = makeBinding(1);
    while (
      Buffer.byteLength(
        JSON.stringify({ ...state, bindings: [...state.bindings, candidate] }) +
          "\n",
      ) <=
      512 * 1024
    ) {
      state.bindings.push(candidate);
      candidate = makeBinding(state.bindings.length);
    }
    writeFileSync(path, JSON.stringify(state) + "\n");
    const changed = vi.fn(async () => {});
    const store = new ProviderCredentialStore(dataDirectory, changed);
    const before = store.catalog();
    const bytes = readFileSync(path);
    await expect(
      store.upsert({ ...candidate, secret: null, activate: true }),
    ).rejects.toThrow("desktop_config_too_large");
    expect(store.catalog()).toEqual(before);
    expect(changed).not.toHaveBeenCalled();
    expect(readFileSync(path)).toEqual(bytes);
    expect(
      new ProviderCredentialStore(dataDirectory, changed).catalog(),
    ).toEqual(before);
    expect(readdirSync(dataDirectory)).toEqual(["provider-credentials.json"]);
  });

  it.each(["upsert", "activate", "delete"] as const)(
    "keeps active provider, restart callback, disk and reopen consistent after failed %s",
    async (operation) => {
      vi.stubEnv("AICUICAN_API_KEY", "");
      const dataDirectory = directory();
      const onChange = vi.fn(async () => {});
      const store = new ProviderCredentialStore(dataDirectory, onChange);
      await store.upsert(provider("first"));
      await store.upsert({ ...provider("second"), activate: false });
      const catalog = store.catalog();
      const active = store.active();
      const path = join(dataDirectory, "provider-credentials.json");
      const bytes = readFileSync(path);
      onChange.mockClear();
      const change = () =>
        operation === "upsert"
          ? store.upsert(provider("second"))
          : operation === "activate"
            ? store.activate("second")
            : store.delete("first");
      fault.rename = true;
      await expect(change()).rejects.toThrow("disk_fault");
      expect(store.catalog()).toEqual(catalog);
      expect(store.active()).toEqual(active);
      expect(onChange).not.toHaveBeenCalled();
      expect(readFileSync(path)).toEqual(bytes);
      expect(
        new ProviderCredentialStore(dataDirectory, onChange).catalog(),
      ).toEqual(catalog);
      expect(readdirSync(dataDirectory)).toEqual(["provider-credentials.json"]);
      fault.rename = false;
      await change();
      expect(onChange).toHaveBeenCalledOnce();
      expect(store.active()?.providerId ?? null).toBe(
        operation === "delete" ? null : "second",
      );
      expect(
        new ProviderCredentialStore(dataDirectory, onChange).catalog(),
      ).toEqual(store.catalog());
    },
  );

  it.each(["select", "clear"] as const)(
    "keeps workspace roots and revisions authoritative after failed %s",
    (operation) => {
      const dataDirectory = directory();
      const first = join(dataDirectory, "first");
      const second = join(dataDirectory, "second");
      mkdirSync(first);
      mkdirSync(second);
      const authority = new LocalWorkspaceAuthority(dataDirectory);
      authority.select(first, {
        expectedRevision: 0,
        idempotencyKey: "initial",
      });
      const captured = authority.captureRoot();
      const status = authority.status();
      const path = join(dataDirectory, "desktop-workspace.json");
      const bytes = readFileSync(path);
      const request = { expectedRevision: 1, idempotencyKey: "change" };
      const change = () =>
        operation === "select"
          ? authority.select(second, request)
          : authority.clear(request);
      fault.rename = true;
      expect(change).toThrow("disk_fault");
      expect(authority.status()).toEqual(status);
      expect(() => authority.assertRootCurrent(captured)).not.toThrow();
      expect(readFileSync(path)).toEqual(bytes);
      expect(new LocalWorkspaceAuthority(dataDirectory).status()).toEqual(
        status,
      );
      expect(
        readdirSync(dataDirectory).some((name) => name.endsWith("pending-v1")),
      ).toBe(false);
      fault.rename = false;
      expect(change().outcome).toBe("committed");
      expect(authority.status().revision).toBe(2);
      expect(() => authority.assertRootCurrent(captured)).toThrow(
        "desktop_sandbox_workspace_changed",
      );
      expect(new LocalWorkspaceAuthority(dataDirectory).status()).toEqual(
        authority.status(),
      );
    },
  );

  it.each(["upsert", "delete"] as const)(
    "retains the Agent Platform credential through actual writer %s failure",
    (operation) => {
      const dataDirectory = directory();
      const encryption = {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "gnome_libsecret" as const,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString(),
      };
      const store = new AgentPlatformCredentialStore(dataDirectory, encryption);
      const origin = "https://platform.example";
      const apiKey = "bpk_original-fixture-key";
      store.upsert({ origin, apiKey });
      const path = join(dataDirectory, "agent-platform-credentials.json");
      const bytes = readFileSync(path);
      const change = () =>
        operation === "upsert"
          ? store.upsert({ origin, apiKey: "bpk_replacement-fixture-key" })
          : store.delete(origin);
      fault.rename = true;
      expect(change).toThrow("disk_fault");
      expect(store.secretForOrigin(origin)).toBe(apiKey);
      expect(readFileSync(path)).toEqual(bytes);
      expect(
        new AgentPlatformCredentialStore(
          dataDirectory,
          encryption,
        ).secretForOrigin(origin),
      ).toBe(apiKey);
      expect(readdirSync(dataDirectory)).toEqual([
        "agent-platform-credentials.json",
      ]);
      fault.rename = false;
      change();
      expect(
        new AgentPlatformCredentialStore(dataDirectory, encryption).catalog(),
      ).toEqual(store.catalog());
    },
  );
});
