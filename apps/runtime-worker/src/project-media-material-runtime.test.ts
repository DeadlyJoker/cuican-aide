import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, stat, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createProjectMediaMaterialRuntime,
  type ProjectMediaMaterialRuntime,
} from "@crewon/media-runtime/project-media-material-runtime";
import { createComfyUiProjectReferenceMaterialAdapter as sharedDecoder } from "@crewon/media-runtime/comfyui-project-reference-material-adapter";
import { createComfyUiProjectReferenceMaterialAdapter as workerDecoder } from "./comfyui-project-reference-material-adapter.ts";
import { projectMediaInputFixture } from "./project-media-input.test-support.ts";
import { materialRuntimeFixtureInput } from "./project-media-material-runtime.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";

async function fixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  kind: "T10" | "D18" = "T10",
) {
  const f = await projectMediaInputFixture(t, backend);
  const root = await mkdtemp(join(tmpdir(), "crewon-material-runtime-")),
    identity = await stat(root);
  const owners: ProjectMediaMaterialRuntime[] = [];
  t.after(async () => {
    for (const owner of owners) await owner.close();
    const current = await stat(root);
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    await rm(root, { recursive: true });
  });
  const input = materialRuntimeFixtureInput(f, {
    archiveId: "real-material-runtime",
    rootDirectory: root,
    keyId: "named-material-runtime-key",
    encryptionKey: Buffer.alloc(32, 72),
  });
  const owner = await createProjectMediaMaterialRuntime(input);
  owners.push(owner);
  const saved = await f.app.saveInput(
    f.actor,
    kind === "T10" ? f.command : f.d18Command,
  );
  const query = {
    projectId: saved.input.projectId,
    mediaInputId: saved.input.mediaInputId,
    inputRevision: saved.input.inputRevision,
    expectedInputRevision: saved.input.inputRevision,
  };
  const prepare = () =>
    owner.materials.prepareInput(f.actor, query, { signal: input.signal });
  return { ...f, root, input, owner, owners, query, prepare };
}
test("Worker and shared Comfy reference decoder retain exactly the same function identity", () =>
  assert.equal(workerDecoder, sharedDecoder));
for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["T10", "D18"] as const)
    test(
      `${backend} ${kind}: shared material factory prepares actual encrypted references and original journal`,
      assetTestOptions(backend),
      async (t) => {
        const f = await fixture(t, backend, kind);
        assert.deepEqual([f.state.sourceGets, f.state.uploads], [0, 0]);
        const result = await f.prepare();
        assert.equal(result.disposition, "verified");
        assert.equal(result.materials.length, kind === "T10" ? 1 : 3);
        assert.equal(f.state.sourceGets, result.materials.length);
        assert.equal(f.state.uploads, result.materials.length);
        const names = await readdir(f.root);
        assert.ok(names.length >= result.materials.length * 2);
        for (const name of names) {
          const path = join(f.root, name),
            file = await readFile(path);
          assert.equal(file.includes(f.state.bytes), false);
          assert.equal((await stat(path)).mode & 0o777, 0o600);
        }
        const before = [f.state.sourceGets, f.state.uploads];
        const replay = await f.prepare();
        assert.equal(replay.disposition, "verified");
        assert.deepEqual(
          replay.materials.map((m) => m.preparation.state.initial),
          result.materials.map((m) => m.preparation.state.initial),
        );
        assert.deepEqual([f.state.sourceGets, f.state.uploads], before);
      },
    );
  test(
    `${backend}: closing and cold reopening the original database restores encrypted inputs without recapture or upload`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const first = await f.prepare(),
        io = [f.state.sourceGets, f.state.uploads];
      await f.owner.close();
      await f.owner.close();
      await assert.rejects(f.prepare());
      const cold = await f.cold();
      const input = materialRuntimeFixtureInput(
        { ...f, ...cold },
        f.input.archive,
      );
      const owner = await createProjectMediaMaterialRuntime(input);
      f.owners.push(owner);
      const next = await owner.materials.prepareInput(f.actor, f.query, {
        signal: input.signal,
      });
      assert.equal(next.disposition, "verified");
      assert.deepEqual(
        next.materials.map((m) => m.preparation.state.initial),
        first.materials.map((m) => m.preparation.state.initial),
      );
      assert.deepEqual([f.state.sourceGets, f.state.uploads], io);
      await owner.close();
      const wrong = await createProjectMediaMaterialRuntime({
        ...input,
        archive: { ...input.archive, encryptionKey: Buffer.alloc(32, 99) },
      });
      f.owners.push(wrong);
      await assert.rejects(
        wrong.materials.prepareInput(f.actor, f.query, {
          signal: input.signal,
        }),
      );
      assert.deepEqual([f.state.sourceGets, f.state.uploads], io);
    },
  );
  test(
    `${backend}: metadata and project rights cannot substitute for source/freeze/upload permission`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      f.state.freezeAllowed = false;
      await assert.rejects(f.prepare(), /denied/u);
      assert.deepEqual([f.state.sourceGets, f.state.uploads], [0, 0]);
      f.state.freezeAllowed = true;
      f.state.readAllowed = false;
      await assert.rejects(f.prepare(), /denied/u);
      assert.deepEqual([f.state.sourceGets, f.state.uploads], [0, 0]);
      f.state.readAllowed = true;
      f.state.uploadAllowed = false;
      await assert.rejects(f.prepare(), /denied/u);
      assert.equal(f.state.uploads, 0);
      assert.equal(f.state.sourceGets, 1);
    },
  );
  test(
    `${backend}: factory snapshots the archive key before migration and cannot use a closed or forged owner`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const key = Buffer.alloc(32, 72),
        config = {
          ...f.input,
          archive: { ...f.input.archive, encryptionKey: key },
        };
      const pending = createProjectMediaMaterialRuntime(config);
      key.fill(0);
      const owner = await pending;
      f.owners.push(owner);
      const result = await owner.materials.prepareInput(f.actor, f.query, {
        signal: f.input.signal,
      });
      assert.equal(result.disposition, "verified");
      await owner.close();
      // The first owner uses the original captured key, not the caller's subsequently zeroed buffer.
      assert.equal((await f.prepare()).disposition, "verified");
      await assert.rejects(
        createProjectMediaMaterialRuntime({
          ...f.input,
          configurations: { ...f.configurations } as never,
        }),
      );
      const aborted = new AbortController();
      aborted.abort();
      await assert.rejects(
        createProjectMediaMaterialRuntime({
          ...f.input,
          signal: aborted.signal,
        }),
      );
      assert.ok(
        await f.projects.getProject(f.actor, { projectId: f.query.projectId }),
      );
    },
  );
}
