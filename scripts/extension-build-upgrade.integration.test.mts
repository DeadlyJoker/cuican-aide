import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import {
  EXTENSION_HISTORICAL_WORK_ITEM_SCOPE,
  getComfyImplementationDigest,
  retainExtensionBuild,
  resolveRetainedExtensionBuild,
  type ExtensionBuildIdentity,
} from "../packages/agent-version/src/extension-build.ts";
import {
  command,
  installAndVerifyWorkspace,
  snapshotSources,
  stagedIdentity,
} from "./extension-build-upgrade.test-support.mts";

test(
  "independent seven-bundle production builds retain both sides of a Control-only upgrade",
  { timeout: 360_000 },
  async (context) => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "crewon-two-builds-")),
    );
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const before = join(directory, "before"),
      after = join(directory, "after");
    const dataRoot = join(directory, "native-data");
    mkdirSync(dataRoot);
    snapshotSources(before);
    snapshotSources(after);
    const controlEntry = join(after, "apps/control-api/src/main.ts");
    const controlSource = readFileSync(controlEntry, "utf8");
    const oldMessage = "CrewON Control API listening on 127.0.0.1:";
    const newMessage =
      "CrewON Control API listening [upgrade fixture] on 127.0.0.1:";
    assert.equal(controlSource.split(oldMessage).length, 2);
    writeFileSync(controlEntry, controlSource.replace(oldMessage, newMessage));

    context.diagnostic(
      "Installing two independent offline pnpm workspaces and verifying private import paths",
    );
    const beforeDigest = await installAndVerifyWorkspace(
      before,
      context.signal,
    );
    const afterDigest = await installAndVerifyWorkspace(after, context.signal);
    assert.equal(beforeDigest, getComfyImplementationDigest());
    assert.notEqual(afterDigest, beforeDigest);
    for (const root of [before, after]) {
      context.diagnostic(
        `Running actual seven-entry desktop stage for ${root === before ? "before" : "after"}`,
      );
      await command(
        process.execPath,
        [join(root, "scripts/stage-desktop-runtime.ts")],
        root,
        context.signal,
      );
    }
    const first = stagedIdentity(before),
      second = stagedIdentity(after);
    assert.equal(first.identity.implementationDigest, beforeDigest);
    assert.equal(second.identity.implementationDigest, afterDigest);
    const controlDigest = (identity: ExtensionBuildIdentity) =>
      identity.bundles.find(({ file }) => file === "control-api.mjs")!.digest;
    assert.notEqual(
      controlDigest(first.identity),
      controlDigest(second.identity),
    );
    assert.ok(
      readFileSync(join(second.directory, "control-api.mjs"), "utf8").includes(
        newMessage,
      ),
    );
    const retained = [];
    for (const build of [first, second]) {
      retained.push(
        await retainExtensionBuild({
          dataRoot,
          currentBuildDirectory: build.directory,
          expectedImplementationDigest: build.identity.implementationDigest,
        }),
      );
    }
    assert.notEqual(retained[0]!.directory, retained[1]!.directory);
    assert.notEqual(
      retained[0]!.buildIdentityDigest,
      retained[1]!.buildIdentityDigest,
    );
    rmSync(before, { recursive: true, force: true });
    rmSync(after, { recursive: true, force: true });
    for (const [index, build] of retained.entries()) {
      const resolved = await resolveRetainedExtensionBuild({
        dataRoot,
        implementationDigest: build.implementationDigest,
        expectedBuildIdentityDigest: build.buildIdentityDigest,
      });
      assert.equal(
        resolved.historicalWorkItemScope,
        EXTENSION_HISTORICAL_WORK_ITEM_SCOPE,
      );
      assert.deepEqual(
        resolved.bundles.map(({ file, digest }) => ({ file, digest })),
        [first, second][index]!.identity.bundles,
      );
      assert.ok(
        resolved.bundles.every(({ path }) =>
          path.startsWith(build.directory + sep),
        ),
      );
    }
    assert.equal(getComfyImplementationDigest(), beforeDigest);
  },
);
