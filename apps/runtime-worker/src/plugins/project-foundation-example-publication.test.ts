import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseExtensionManifest,
  validateWorkflowSchemaValue,
} from "@crewon/domain";
import {
  installLocalPluginPackage,
  loadInstalledPluginBusinessRegistration,
} from "@crewon/plugin-host";
import { extensionToolDefinitions } from "../extensions/extension-tool-catalog.ts";
import type {
  PluginToolExecutionCommand,
  PluginToolExecutionResolution,
  PluginToolRuntime,
} from "@crewon/plugin-sdk/node";

// Explicit candidate-release test: run after preparing the portable SDK and building Short40.
// It installs into an owned temporary directory, never a user's profile or Applications folder.
const packageDirectory =
  process.env.CREWON_SHORT_DRAMA_PLUGIN_DIR ??
  fileURLToPath(
    new URL(
      "../../../../examples/plugins/short-drama/dist/40.0.0/",
      import.meta.url,
    ),
  );
const fixtureModule = (await import(
  new URL(
    "../../../../examples/plugins/short-drama/test/project-foundation-tools-runtime.test-support.mjs",
    import.meta.url,
  ).href
)) as {
  fixture(): {
    runtime: PluginToolRuntime;
    command(method: string, input: unknown): PluginToolExecutionCommand;
  };
  query: Record<string, unknown>;
  projectId: string;
  proposalDigest: string;
  saveRequest: Record<string, unknown>;
  canonical(input: unknown): string;
};

test("actual Short40 immutable installed bytes register all32 v2 business tools, leaving the old24 definitions intact", async (t) => {
  const directory = await mkdtemp(
      join(tmpdir(), "crewon-short40-publication-"),
    ),
    installRoot = join(directory, "installed");
  t.after(async () => {
    await removeOwnedTree(installRoot);
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(installRoot, { mode: 0o700 });
  const installed = await installLocalPluginPackage({
      directory: packageDirectory,
      installRoot,
      authorization: async () => ({ outcome: "allow" }),
    }),
    registration = await loadInstalledPluginBusinessRegistration({
      installRoot,
      expectedPluginId: installed.descriptor.pluginId,
      expectedPublisherId: installed.descriptor.publisherId,
      expectedVersion: "40.0.0",
      expectedPackageDigest: installed.packageDigest,
      authorizeRead: async () => "allow",
      signal: new AbortController().signal,
    });
  assert.equal(
    registration.manifest.schemaVersion,
    "crewon.extension-manifest.v2",
  );
  assert.equal(registration.manifest.tools.length, 32);
  assert.equal(
    registration.manifest.tools.filter(
      (t) => t.adapterId === "crewon.project-foundation-tools",
    ).length,
    8,
  );
  const source = parseExtensionManifest(
    JSON.parse(await readFile(join(packageDirectory, "business.json"), "utf8")),
  );
  assert.deepEqual(registration.manifest, source);
  const f = fixtureModule.fixture();
  t.after(() => f.runtime.close?.());
  const sorted = (values: readonly { name: string }[]) =>
    [...values].sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(
    fixtureModule.canonical(sorted(f.runtime.definitions())),
    fixtureModule.canonical(sorted(extensionToolDefinitions(source))),
  );
});

test("the actual portable Short40 ESM produces all eight schema-valid whole-bounded model outputs under its exact action limits", async (t) => {
  const manifest = parseExtensionManifest(
      JSON.parse(
        await readFile(join(packageDirectory, "business.json"), "utf8"),
      ),
    ),
    f = fixtureModule.fixture();
  t.after(() => f.runtime.close?.());
  const cases: readonly [string, unknown][] = [
    ["readScope", {}],
    [
      "getFoundation",
      {
        projectId: fixtureModule.projectId,
        parametersStartOffset: 0,
        parametersLimit: 1024,
      },
    ],
    ["getSource", fixtureModule.query],
    ["readSourcePage", { ...fixtureModule.query, startOffset: 1, limit: 1 }],
    ["listSourceChapters", { ...fixtureModule.query, limit: 16 }],
    [
      "getProposal",
      {
        projectId: fixtureModule.projectId,
        proposalRevision: 1,
        proposalDigest: fixtureModule.proposalDigest,
        startOffset: 0,
        limit: 1024,
      },
    ],
    [
      "listProposals",
      {
        projectId: fixtureModule.projectId,
        afterProposalRevision: 0,
        limit: 4,
      },
    ],
    ["saveProposal", fixtureModule.saveRequest],
  ];
  for (const [method, input] of cases) {
    const command = f.command(method, input),
      declaration = manifest.tools.find(
        (t) => "crewon_short_drama__" + t.operationId === command.name,
      );
    assert.ok(declaration);
    validateWorkflowSchemaValue(input, declaration.inputSchema);
    const resolution = (await f.runtime.execute(
      command,
      new AbortController().signal,
    )) as Extract<PluginToolExecutionResolution, { status: "completed" }>;
    assert.equal(resolution.status, "completed");
    assert.ok(Buffer.byteLength(resolution.result.output) <= 9999);
    assert.ok(
      Buffer.byteLength(resolution.result.output) <=
        command.actionIntent.limits.maxOutputBytes,
    );
    const output = validateWorkflowSchemaValue(
      JSON.parse(resolution.result.output),
      declaration.outputSchema,
    ) as { resultJsonParts: readonly string[] };
    for (const scalar of output.resultJsonParts.join("")) {
      const code = scalar.codePointAt(0)!;
      assert.ok(code < 0xd800 || code > 0xdfff);
    }
    JSON.parse(output.resultJsonParts.join(""));
  }
});

async function removeOwnedTree(directory: string): Promise<void> {
  try {
    await chmod(directory, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await removeOwnedTree(join(directory, entry.name));
  await rm(directory, { recursive: true, force: true });
}
