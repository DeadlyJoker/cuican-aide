// @vitest-environment node
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopExtensionHistoricalFixture } from "./desktopExtensionHistoricalInputs.test-support.ts";
import { prepareDesktopExtensionHistoricalWorker } from "./desktopExtensionHistoricalInputs.ts";
import { verifyDesktopExtensionHistoricalMaterials } from "./desktopExtensionHistoricalMaterials.ts";

// Archive lookup is a nonexecuted unit port; capsules, compiled assets and
// the immutable published release use the real filesystem and SQLite Store.
const archive = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@crewon/agent-version/extension-build", () => ({
  EXTENSION_HISTORICAL_WORK_ITEM_SCOPE: "crewon.extension-work-item-scope.v1",
  resolveRetainedExtensionBuild: (...args: unknown[]) =>
    archive.resolve(...args),
}));
const roots: string[] = [];
beforeEach(() => archive.resolve.mockReset());
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture(
  input: Omit<
    Parameters<typeof createDesktopExtensionHistoricalFixture>[0],
    "dataRoot"
  >,
) {
  const dataRoot = mkdtempSync(
    join(realpathSync(tmpdir()), "crewon-historical-profile-unit-"),
  );
  roots.push(dataRoot);
  const value = await createDesktopExtensionHistoricalFixture({
    ...input,
    dataRoot,
  });
  archive.resolve.mockResolvedValue(value.archive);
  return value;
}

describe("historical request format and sequence pins", () => {
  it.each([
    ["standard", "1"],
    ["responsesLite", "1+responses-lite"],
  ] as const)(
    "restores exact published gateway %s inputs without changing saved identity or materials",
    async (requestProfile, adapterVersion) => {
      const value = await fixture({ requestProfile });
      const before = new Map(
        value.manifest.files.map(({ file }) => [
          file,
          readFileSync(join(value.directory, file)),
        ]),
      );
      const databaseBefore = readFileSync(value.databasePath);
      const base = value.documents.get("base-bindings.json") as {
        bindings: Array<{
          agentVersionId: string;
          contentDigest: string;
          provider: { requestProfile: string; sequencePolicy: string };
        }>;
      };
      const release = value.documents.get("release.json") as {
        plan: {
          bootstrapVersion: { contentDigest: string };
          versions: Array<{
            agentVersionId: string;
            contentDigest: string;
            model: { adapterVersion: string };
          }>;
        };
      };
      // Includes default, profile and both model variants, not only bootstrap.
      expect(base.bindings).toHaveLength(4);
      for (const binding of base.bindings) {
        expect(binding.provider).toMatchObject({
          requestProfile,
          sequencePolicy: "whenPresent",
        });
        expect(
          release.plan.versions.find(
            (version) => version.agentVersionId === binding.agentVersionId,
          ),
        ).toMatchObject({
          contentDigest: binding.contentDigest,
          model: { adapterVersion },
        });
      }
      const materials = verifyDesktopExtensionHistoricalMaterials({
        dataRoot: value.selection.dataRoot,
        manifest: value.manifest,
        directory: value.directory,
        documents: value.documents,
      });
      expect(materials.inputs).toEqual(value.bootstrap);
      expect(materials.inputs.model).toMatchObject({
        requestProfile,
        sequencePolicy: "whenPresent",
        identityPolicy: "terminalAuthoritative",
        outputDeltaFlushBytes: 1024,
        storeResponses: false,
      });
      expect(materials.bootstrapContentDigest).toBe(
        release.plan.bootstrapVersion.contentDigest,
      );
      const result = await prepareDesktopExtensionHistoricalWorker({
        selection: value.selection,
        resolveProvider: value.resolveProvider,
      });
      expect(result.outcome).toBe("ready");
      if (result.outcome !== "ready") throw new Error("fixture_plan_missing");
      expect(result.manifest).toEqual(value.manifest);
      expect(result.environment).toMatchObject({
        CREWON_RESPONSES_REQUEST_PROFILE: requestProfile,
        CREWON_RESPONSES_SEQUENCE_POLICY: "whenPresent",
        CREWON_RESPONSES_OUTPUT_DELTA_FLUSH_BYTES: "1024",
        CREWON_AGENT_VERSION_CONTENT_DIGEST:
          release.plan.bootstrapVersion.contentDigest,
      });
      for (const [file, bytes] of before)
        expect(readFileSync(join(value.directory, file))).toEqual(bytes);
      expect(readFileSync(value.databasePath)).toEqual(databaseBefore);
    },
  );

  it.each([
    ["standard", "responsesLite", "whenPresent"],
    ["responsesLite", "standard", "whenPresent"],
    ["standard", "standard", "required"],
    ["responsesLite", "responsesLite", "required"],
  ] as const)(
    "rejects saved %s inputs with base binding %s/%s before resolving credentials",
    async (requestProfile, bindingProfile, bindingSequence) => {
      const value = await fixture({
        requestProfile,
        mutate(documents) {
          const base = documents.get("base-bindings.json") as {
            bindings: Array<{
              provider: { requestProfile: string; sequencePolicy: string };
            }>;
          };
          base.bindings[0]!.provider.requestProfile = bindingProfile;
          base.bindings[0]!.provider.sequencePolicy = bindingSequence;
        },
      });
      const resolveProvider = vi.fn(value.resolveProvider);
      const result = await prepareDesktopExtensionHistoricalWorker({
        selection: value.selection,
        resolveProvider,
      });
      expect(result).toEqual({
        outcome: "unavailable",
        capsuleId: value.selection.capsuleId,
        reasonCode: "desktop_extension_historical_inputs_unavailable",
      });
      expect(resolveProvider).not.toHaveBeenCalled();
    },
  );
});
