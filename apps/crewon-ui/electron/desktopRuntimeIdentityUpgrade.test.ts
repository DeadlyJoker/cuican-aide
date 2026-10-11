// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentVersionAsset } from "@crewon/agent-version";
import { SqliteRunStore } from "@crewon/store";
import { describe, expect, it } from "vitest";
import { compileRuntimeAgentVersion } from "../../runtime-worker/src/agent-version-release.ts";
import { createModelTransport } from "../../runtime-worker/src/runtime-process-environment.ts";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
import {
  DESKTOP_RUNTIME_CONTRACT,
  desktopRuntimeFingerprint,
} from "./runtimeSupervisor.ts";

const input = {
  providerId: "provider-1",
  endpoint: "https://gateway.example/v1",
  modelId: "gpt-6-astra",
  modelCatalog: ["gpt-6-astra", "gpt-6.1-sol"],
  agentProfiles: [],
  localWorkspaceMcp: null,
} as const;
const legacyFingerprint = createHash("sha256")
  .update(
    JSON.stringify({
      ...input,
      runtimeContract: "crewon.electron-typescript-runtime.v2",
    }),
  )
  .digest("hex");

describe("desktop Standard request identity upgrade", () => {
  it("keeps the new runtime identity stable and distinct from the legacy Lite identity", () => {
    expect(DESKTOP_RUNTIME_CONTRACT).toBe(
      "crewon.electron-typescript-runtime.v3",
    );
    const current = desktopRuntimeFingerprint(input);
    expect(current).not.toBe(legacyFingerprint);
    expect(desktopRuntimeFingerprint(input)).toBe(current);
  });

  it("publishes default Standard beside saved Lite without changing the old immutable asset", async () => {
    const directory = mkdtempSync(
      join(realpathSync(tmpdir()), "crewon-desktop-identity-upgrade-"),
    );
    const store = new SqliteRunStore(join(directory, "control.sqlite"));
    const environment = {
      CREWON_RESPONSES_ENDPOINT: `${input.endpoint}/responses`,
      CREWON_MODEL_ID: input.modelId,
    };
    const lite = createModelTransport(
      "responses",
      {},
      {
        ...environment,
        CREWON_RESPONSES_REQUEST_PROFILE: "responsesLite",
        CREWON_RESPONSES_OUTPUT_DELTA_FLUSH_BYTES: "1024",
      },
    );
    const standard = createModelTransport("responses", {}, environment);
    const legacyId = `local-desktop-${legacyFingerprint.slice(0, 24)}`;
    const currentFingerprint = desktopRuntimeFingerprint(input);
    const currentId = `local-desktop-${currentFingerprint.slice(0, 24)}`;
    const compile = (fingerprint: string, transport: typeof standard) =>
      compileRuntimeAgentVersion({
        runtimeTenantId: DESKTOP_RUNTIME_OWNER.tenantId,
        route: {
          authorityId: "standalone-authority",
          runtimeGeneration: `desktop-${fingerprint.slice(0, 32)}`,
          agentVersionId: `local-desktop-${fingerprint.slice(0, 24)}`,
          policySnapshotId: "standalone-policy-v0",
          workspaceBindingId: null,
        },
        transport,
        nativeWorkspaceReadCatalog: "disabled",
      });
    try {
      expect(lite.adapterVersion).toBe("1+responses-lite");
      expect(standard.adapterVersion).toBe("1");
      const legacy = createAgentVersionAsset({
        tenantId: DESKTOP_RUNTIME_OWNER.tenantId,
        version: compile(legacyFingerprint, lite),
        createdAt: "2026-10-10T00:00:00.000Z",
      });
      await store.registerAgentVersion(legacy);
      // This is the former upgrade failure: unchanged identity with a newly
      // compiled Standard model is rejected by the actual immutable Store.
      await expect(
        store.registerAgentVersion(
          createAgentVersionAsset({
            tenantId: DESKTOP_RUNTIME_OWNER.tenantId,
            version: compile(legacyFingerprint, standard),
            createdAt: "2026-10-11T00:00:00.000Z",
          }),
        ),
      ).rejects.toMatchObject({ code: "agent_version_id_conflict" });
      const current = createAgentVersionAsset({
        tenantId: DESKTOP_RUNTIME_OWNER.tenantId,
        version: compile(currentFingerprint, standard),
        createdAt: "2026-10-11T00:00:00.000Z",
      });
      await store.registerAgentVersion(current);
      expect(
        await store.loadAgentVersion({
          tenantId: DESKTOP_RUNTIME_OWNER.tenantId,
          agentVersionId: legacyId,
        }),
      ).toEqual(legacy);
      expect(
        await store.loadAgentVersion({
          tenantId: DESKTOP_RUNTIME_OWNER.tenantId,
          agentVersionId: currentId,
        }),
      ).toEqual(current);
    } finally {
      await Promise.all([lite.close?.(), standard.close?.()]);
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
