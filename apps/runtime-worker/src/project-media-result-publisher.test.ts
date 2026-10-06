import assert from "node:assert/strict";
import test from "node:test";
import {
  readdirSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { mediaResultFixture as fixture } from "./project-media-result-publisher.test-support.ts";
import { createProjectMediaResultCandidate } from "@crewon/application";
import { FilesystemProjectMediaResultArchive } from "@crewon/artifacts";
import { observeMaterialPreparationSql } from "../../../packages/store/src/project-material-preparation.test-support.ts";
import {
  mediaInputDigest,
  parseProjectMediaResultSource,
} from "@crewon/application";
const signal = () => ({ signal: new AbortController().signal });
for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["T10", "D18"] as const)
    test(
      `${backend} ${kind}: real installed operation publishes actual PNG candidate and cold reads original bytes`,
      assetTestOptions(backend),
      async (t) => {
        const f = await fixture(t, backend, kind),
          before = f.materialCounts();
        const saved = await f.publisher.publish(f.actor, f.query, signal());
        assert.equal(saved.disposition, "created");
        const c = saved.candidate;
        assert.equal(
          c.frozen.source.projection.reference.executionId,
          f.task.reference.executionId,
        );
        assert.equal(
          c.frozen.source.projection.reference.mediaInputDigest,
          f.task.reference.mediaInputDigest,
        );
        assert.equal(c.frozen.source.projection.request.query.resultIndex, 0);
        assert.equal(
          c.frozen.source.projection.workflow.output.nodeId,
          kind === "T10" ? "129" : "17",
        );
        assert.equal(
          c.frozen.source.byteDigest,
          "sha256:" + createHash("sha256").update(f.state.bytes).digest("hex"),
        );
        assert.deepEqual(
          [c.frozen.source.width, c.frozen.source.height],
          [2, 1],
        );
        assert.equal(f.state.gets, 1);
        assert.equal(await f.count(), 1);
        const replay = await f.publisher.publish(f.actor, f.query, signal());
        assert.equal(replay.disposition, "replayed");
        assert.deepEqual(replay.candidate, c);
        assert.equal(f.state.gets, 1);
        await f.publisher.close();
        f.archive.close();
        const cold = await f.cold(),
          child = cold.ext.projectMediaResults();
        await child.migrate();
        const next = await f.open(child);
        f.state.bytes = Buffer.from(
          "supplier bytes changed after original freeze",
        );
        const restored = await next.publisher.readCandidate(
          f.actor,
          f.query,
          signal(),
        );
        assert.ok(restored);
        assert.deepEqual(restored.candidate, c);
        assert.equal(restored.bytes.length, c.frozen.source.byteLength);
        assert.equal(
          "sha256:" + createHash("sha256").update(restored.bytes).digest("hex"),
          c.frozen.source.byteDigest,
        );
        assert.equal(f.state.gets, 1);
        assert.deepEqual(f.materialCounts(), before);
        assert.equal(f.controls.posts, 1);
      },
    );
  test(
    `${backend}: distinct original positions remain separate candidates without adopting upstream assets`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.referenceSource(),
        a = await f.publisher.publish(f.actor, f.query, signal()),
        b = await f.publisher.publish(
          f.actor,
          { ...f.query, resultIndex: 1 },
          signal(),
        );
      assert.notEqual(a.candidate.candidateId, b.candidate.candidateId);
      assert.notEqual(
        a.candidate.frozen.materialId,
        b.candidate.frozen.materialId,
      );
      assert.equal(
        b.candidate.frozen.source.projection.request.query.resultIndex,
        1,
      );
      assert.equal(await f.count(), 2);
      assert.equal(f.state.gets, 2);
      const source = await f.referenceSource();
      assert.deepEqual(source, before);
    },
  );
  test(
    `${backend}: not-ready operation and caller URLs, wrong project or owner cannot trigger media reads`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend, "T10", { generate: false });
      await assert.rejects(
        f.publisher.publish(f.actor, f.query, signal()),
        /project_media_result_not_found|project_media_result_not_ready/u,
      );
      for (const query of [
        { ...f.query, url: "https://evil.example/" },
        { ...f.query, projectId: "wrong" },
        { ...f.query, resultIndex: 16 },
      ])
        await assert.rejects(f.publisher.publish(f.actor, query, signal()));
      await assert.rejects(
        f.publisher.publish(
          { ...f.actor, principalId: "other-owner" },
          f.query,
          signal(),
        ),
      );
      assert.equal(f.state.gets, 0);
      assert.equal(await f.count(), 0);
    },
  );
  test(
    `${backend}: revocation after DNS, malformed PNG/encoding and cancellation publish no candidate`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      f.state.onDns = async () => {
        f.state.publish = false;
      };
      await assert.rejects(
        f.publisher.publish(f.actor, f.query, signal()),
        /permission_revoked/u,
      );
      assert.equal(f.state.gets, 0);
      f.state.publish = true;
      f.state.onDns = undefined;
      f.state.response = (r) => ({
        ...r,
        headers: { ...r.headers, "content-encoding": "gzip" },
      });
      await assert.rejects(
        f.publisher.publish(f.actor, f.query, signal()),
        /response_invalid/u,
      );
      f.state.response = undefined;
      const bytes = f.state.bytes;
      f.state.bytes = Buffer.from("not a PNG");
      await assert.rejects(
        f.publisher.publish(f.actor, f.query, signal()),
        /project_reference_material_png_invalid/u,
      );
      f.state.bytes = bytes;
      const controller = new AbortController();
      f.state.onGet = async () => {
        controller.abort(new Error("named_result_cancel"));
      };
      await assert.rejects(
        f.publisher.publish(f.actor, f.query, { signal: controller.signal }),
        /named_result_cancel/u,
      );
      assert.equal(await f.count(), 0);
    },
  );
  test(
    `${backend}: archived project rejects new publication while original candidate remains readable`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        a = await f.publisher.publish(f.actor, f.query, signal());
      const p = await f.projects.getProject(f.actor, {
        projectId: f.query.projectId,
      });
      await f.projects.setProjectState(f.actor, {
        projectId: p.projectId,
        expectedProjectRevision: p.revision,
        state: "archived",
        idempotencyKey: "result-archive-project",
      });
      await assert.rejects(
        f.publisher.publish(f.actor, { ...f.query, resultIndex: 1 }, signal()),
        /project_archived/u,
      );
      const restored = await f.publisher.readCandidate(
        f.actor,
        f.query,
        signal(),
      );
      assert.deepEqual(restored?.candidate, a.candidate);
      assert.equal(await f.count(), 1);
      assert.equal(f.state.gets, 1);
    },
  );
  test(
    `${backend}: missing or damaged frozen data never rereads supplier or replaces candidate`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        saved = await f.publisher.publish(f.actor, f.query, signal()),
        data = join(
          f.archiveConfig.rootDirectory,
          saved.candidate.frozen.materialId + ".crwpr",
        ),
        original = readFileSync(data);
      writeFileSync(data, Buffer.alloc(original.length, 13));
      await assert.rejects(
        f.publisher.readCandidate(f.actor, f.query, signal()),
      );
      writeFileSync(data, original);
      unlinkSync(data);
      await assert.rejects(
        f.publisher.publish(f.actor, f.query, signal()),
        /content_missing/u,
      );
      await assert.rejects(
        f.publisher.readCandidate(f.actor, f.query, signal()),
        /content_missing/u,
      );
      assert.equal(f.state.gets, 1);
      assert.equal(await f.count(), 1);
    },
  );
  test(
    `${backend}: concurrent actual result publishers keep first frozen bytes and one native candidate`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        second = await f.open();
      const results = await Promise.all([
        f.publisher.publish(f.actor, f.query, signal()),
        second.publisher.publish(f.actor, f.query, signal()),
      ]);
      assert.deepEqual(results[0].candidate, results[1].candidate);
      assert.equal(await f.count(), 1);
      assert.ok(f.state.gets <= 2);
      assert.equal(f.controls.posts, 1);
    },
  );
  test(
    `${backend}: native child requires explicit migration and rejects forged candidate/source and async activity`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend, "T10", { migrate: false });
      await assert.rejects(
        f.publisher.publish(f.actor, f.query, signal()),
        /unavailable/u,
      );
      assert.equal(f.state.gets, 0);
      await f.store.migrate();
      const saved = await f.publisher.publish(f.actor, f.query, signal());
      const altered = createProjectMediaResultCandidate({
        ...saved.candidate.frozen,
        source: {
          ...saved.candidate.frozen.source,
          byteDigest: "sha256:" + "1".repeat(64),
        },
      });
      await assert.rejects(
        f.store.saveCandidate(altered, f.authority("publish")),
        /conflict/u,
      );
      await assert.rejects(
        f.store.loadCandidate(f.request, {
          ...f.authority(),
          assertActive: async () => {
            throw new Error("named_async_activity");
          },
        }),
        /authority_invalid/u,
      );
      assert.equal(await f.count(), 1);
    },
  );
  test(
    `${backend}: owning principal reads the original actor's frozen candidate and revoked read prevents replay`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        first = await f.publisher.publish(f.actor, f.query, signal()),
        anotherActor = { ...f.actor, actorId: "another-owned-actor" },
        read = await f.publisher.readCandidate(anotherActor, f.query, signal()),
        replay = await f.publisher.publish(anotherActor, f.query, signal());
      assert.deepEqual(read?.candidate, first.candidate);
      assert.deepEqual(replay.candidate, first.candidate);
      assert.deepEqual(replay.candidate.frozen.request.actor, f.actor);
      f.state.read = false;
      await assert.rejects(
        f.publisher.readCandidate(f.actor, f.query, signal()),
        /permission_revoked/u,
      );
      await assert.rejects(
        f.publisher.publish(f.actor, f.query, signal()),
        /permission_revoked/u,
      );
      assert.equal(f.state.gets, 1);
      assert.equal(await f.count(), 1);
    },
  );
  test(
    `${backend}: native INSERT rolls back on owner retirement and reuses original encrypted bytes on recovery`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const restore = observeMaterialPreparationSql(
        backend,
        /INSERT INTO .*project_media_result_candidates/u,
        () => {
          f.state.active = false;
        },
      );
      try {
        await assert.rejects(
          f.publisher.publish(f.actor, f.query, signal()),
          /owner_retired/u,
        );
      } finally {
        restore();
      }
      assert.equal(await f.count(), 0);
      assert.equal(f.state.gets, 1);
      const frozen = await f.archive.load(f.request);
      assert.ok(frozen);
      f.state.active = true;
      const saved = await f.publisher.publish(f.actor, f.query, signal());
      assert.deepEqual(saved.candidate.frozen, frozen.record);
      assert.equal(saved.disposition, "created");
      assert.equal(f.state.gets, 1);
      for (const sql of [
        `UPDATE ${f.prefix}project_media_result_candidates SET content_digest='changed'`,
        `DELETE FROM ${f.prefix}project_media_result_candidates`,
        `UPDATE ${f.prefix}project_media_result_schema_version SET version=2`,
      ])
        await assert.rejects(f.sql(sql), /immutable/u);
      assert.deepEqual(
        (await f.publisher.readCandidate(f.actor, f.query, signal()))
          ?.candidate,
        saved.candidate,
      );
      assert.equal(await f.count(), 1);
    },
  );
  test(
    `${backend}: archive during DNS qualification and private DNS results never trigger a physical GET`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      f.state.addresses = [{ address: "198.18.12.7", family: 4 }];
      await assert.rejects(f.publisher.publish(f.actor, f.query, signal()));
      assert.equal(f.state.gets, 0);
      f.state.addresses = [{ address: "8.8.8.8", family: 4 }];
      f.state.onDns = async () => {
        const p = await f.projects.getProject(f.actor, {
          projectId: f.query.projectId,
        });
        await f.projects.setProjectState(f.actor, {
          projectId: p.projectId,
          expectedProjectRevision: p.revision,
          state: "archived",
          idempotencyKey: "archive-during-result-dns",
        });
      };
      await assert.rejects(
        f.publisher.publish(f.actor, f.query, signal()),
        /project_archived/u,
      );
      assert.equal(f.state.gets, 0);
      assert.equal(await f.count(), 0);
    },
  );
  test(
    `${backend}: original source only permits same-origin output references and sealed result files reject identity loss`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        source = await f.store.loadSource(f.request, f.authority());
      for (const image of [
        { ...source.image, url: "https://other.example/view" },
        { ...source.image, type: "input" },
        { ...source.image, filename: "../escape.png" },
        { ...source.image, subfolder: "../escape" },
      ]) {
        const { contentDigest: _old, ...body } = { ...source, image };
        assert.throws(
          () =>
            parseProjectMediaResultSource({
              ...body,
              contentDigest: mediaInputDigest(body),
            }),
          /image_invalid/u,
        );
      }
      assert.equal(f.state.gets, 0);
      const saved = await f.publisher.publish(f.actor, f.query, signal()),
        id = saved.candidate.frozen.materialId,
        data = join(f.archiveConfig.rootDirectory, id + ".crwpr"),
        intent = join(f.archiveConfig.rootDirectory, id + ".intent-crwpr"),
        encrypted = readFileSync(data);
      assert.equal(encrypted.includes(f.state.bytes), false);
      assert.equal(
        encrypted.includes(Buffer.from(source.image.filename)),
        false,
      );
      const wrongKey = new FilesystemProjectMediaResultArchive({
        ...f.archiveConfig,
        encryptionKey: Buffer.alloc(32, 81),
      });
      try {
        await assert.rejects(wrongKey.load(f.request), /ciphertext_invalid/u);
      } finally {
        wrongKey.close();
      }
      const preservedIntent = readFileSync(intent);
      unlinkSync(intent);
      await assert.rejects(
        f.publisher.readCandidate(f.actor, f.query, signal()),
        /intent_missing/u,
      );
      writeFileSync(intent, preservedIntent, { mode: 0o600 });
      const external = join(f.root, "external-encrypted-data");
      renameSync(data, external);
      symlinkSync(external, data);
      await assert.rejects(
        f.publisher.readCandidate(f.actor, f.query, signal()),
        /file_invalid/u,
      );
      unlinkSync(data);
      renameSync(external, data);
      const oldRoot = f.archiveConfig.rootDirectory + "-original";
      renameSync(f.archiveConfig.rootDirectory, oldRoot);
      mkdirSync(f.archiveConfig.rootDirectory, { mode: 0o700 });
      await assert.rejects(
        f.publisher.readCandidate(f.actor, f.query, signal()),
        /path_invalid/u,
      );
      assert.equal(f.state.gets, 1);
      assert.equal(await f.count(), 1);
      assert.ok(readdirSync(oldRoot).includes(id + ".crwpr"));
    },
  );
  test(
    `${backend}: publisher closes and joins its own physical read before retirement`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((r) => (entered = r)),
        held = new Promise<void>((r) => (release = r));
      f.state.onGet = async () => {
        entered();
        await held;
      };
      const pending = f.publisher.publish(f.actor, f.query, signal());
      void pending.catch(() => {});
      await started;
      let closed = false;
      const closing = f.publisher.close().then(() => (closed = true));
      await new Promise((r) => setImmediate(r));
      assert.equal(closed, false);
      release();
      await assert.rejects(pending, /closed/u);
      await closing;
      assert.equal(closed, true);
      assert.equal(await f.count(), 0);
    },
  );
}
