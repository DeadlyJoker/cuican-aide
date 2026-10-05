import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  packageFixture,
  allowInstallation,
} from "./local-plugin-package.test-support.ts";
import { installLocalPluginPackage } from "./local-plugin-package-installer.ts";
import { verifyInstalledProjectActionDeclaration } from "./plugin-action-declaration.ts";

async function fixture(t: test.TestContext, declarations: string) {
  const f = await packageFixture(t);
  const code = Buffer.from(
    `import {appendFileSync} from 'node:fs';const log=x=>appendFileSync(${JSON.stringify(f.marker)},x+'\\n');export default {apiVersion:'crewon.plugin-host.v1',pluginId:'example.fixture',setup(ctx){if(ctx.services.getOptional('crewon.project-tools','1')!=null)throw Error('unexpected-write-service');log('setup');const r=ctx.services.provide('example.fixture','1',{actions:${declarations},invoke(){log('invoked');throw Error('never invoke');}});return {async dispose(){await Promise.resolve();r.dispose();log('disposed');}};}};`,
  );
  await writeFile(join(f.source, "dist/entry.mjs"), code);
  await f.rewriteDescriptor({
    ...f.descriptor,
    requires: [
      { service: "crewon.project-tools", apiVersion: "1", optional: true },
    ],
    provides: [{ service: "example.fixture", apiVersion: "1" }],
    files: f.descriptor.files.map((entry) =>
      entry.path === "dist/entry.mjs"
        ? {
            ...entry,
            byteLength: code.length,
            sha256: createHash("sha256").update(code).digest("hex"),
          }
        : entry,
    ),
  });
  const installed = await installLocalPluginPackage({
    directory: f.source,
    installRoot: f.installRoot,
    authorization: allowInstallation,
  });
  return {
    f,
    run: (current: () => Promise<void> = async () => {}) =>
      verifyInstalledProjectActionDeclaration({
        installRoot: f.installRoot,
        pluginId: "example.fixture",
        packageDigest: installed.packageDigest,
        contributionId: "workbench",
        assertCurrent: current,
        assertActive() {},
      }),
  };
}
test("reads actual published generateTask without a writable host service/action and physically disposes", async (t) => {
  const { f, run } = await fixture(
    t,
    "[{contributionId:'workbench',action:'project.execute',kind:'generateTask'}]",
  );
  let checked = 0;
  await run(async () => {
    checked++;
  });
  assert.ok(checked >= 3);
  assert.equal(await readFile(f.marker, "utf8"), "setup\ndisposed\n");
});
test("wrong kind, absent/duplicate action and accessor declarations fail without invoking", async (t) => {
  for (const declaration of [
    "[]",
    "[{contributionId:'other',action:'project.execute',kind:'generateTask'}]",
    "[{contributionId:'workbench',action:'project.execute',kind:'queryTask'}]",
    "[{contributionId:'workbench',action:'project.execute',kind:'generateTask'},{contributionId:'workbench',action:'project.execute',kind:'generateTask'}]",
    "[{contributionId:'workbench',get action(){throw Error('accessor-called');},kind:'generateTask'}]",
  ]) {
    const { f, run } = await fixture(t, declaration);
    await assert.rejects(run(), /project_conversation_action_unavailable/);
    assert.equal(await readFile(f.marker, "utf8"), "setup\ndisposed\n");
  }
});
test("withdrawal after genuine setup rejects and still joins dispose", async (t) => {
  const { f, run } = await fixture(
    t,
    "[{contributionId:'workbench',action:'project.execute',kind:'generateTask'}]",
  );
  let calls = 0;
  await assert.rejects(
    run(async () => {
      if (++calls > 1) throw Error("actual-owner-withdrawn");
    }),
    /actual-owner-withdrawn/,
  );
  assert.equal(await readFile(f.marker, "utf8"), "setup\ndisposed\n");
});
