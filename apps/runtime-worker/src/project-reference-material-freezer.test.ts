import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FilesystemProjectMaterialArchive } from "@crewon/artifacts";
import type {
  ProjectReferenceMaterialArchivePort,
  ProjectReferenceMaterialFreezeAuthorizationPort,
} from "@crewon/application";
import { projectAssetReferenceImageFixture } from "../../../packages/store/src/project-asset-reference-image.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { ProjectReferenceMaterialReader } from "./project-reference-material-reader.ts";
import { ProjectReferenceMaterialFreezer } from "./project-reference-material-freezer.ts";
import { materialPng } from "./project-material-png.test-support.ts";

/** Real project/source/Run proofs and encrypted disk archive; named media grants, DNS and GET response.
 * This is neither supplier transfer nor installed-plugin/Agent media execution acceptance.
 */
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend} freeze captures exact source bytes and cold replay retains them after mutable provider output changes`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.project.rows(),
        original = Buffer.from(f.state.bytes);
      const first = await f.freezer.freezeSelectedReference(
        f.project.actor,
        f.input,
        signal(),
      );
      assert.equal(first.disposition, "created");
      assert.equal(f.state.gets, 1);
      assert.equal(
        first.record.source.referenceDigest,
        f.grants[0]!.resource.referenceDigest,
      );
      assert.equal(first.record.archiveId, "project-source-archive");
      assert.equal(readdirSync(f.root).length, 2);
      const ciphertext = readFileSync(
        path.join(f.root, `${first.record.materialId}.crwpm`),
      );
      assert.equal(ciphertext.includes(original), false);
      f.archive.close();
      f.state.bytes = materialPng(3, 1);
      const reopened = f.openFreezer();
      const replay = await reopened.freezeSelectedReference(
        f.project.actor,
        f.input,
        signal(),
      );
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.record, first.record);
      assert.equal(f.state.gets, 1);
      const content = await reopened.readFrozenReference(
        f.project.actor,
        f.input,
        signal(),
      );
      assert.deepEqual(content.bytes, original);
      content.bytes.fill(0);
      assert.deepEqual(
        (await reopened.readFrozenReference(f.project.actor, f.input, signal()))
          .bytes,
        original,
      );
      assert.equal(f.state.gets, 1);
      assert.deepEqual(await f.project.rows(), before);
    },
  );
  test(
    `${backend} two callers sharing an original business key coordinate the same immutable source capture`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.project.rows(),
        other = f.openFreezer();
      const outcomes = await Promise.all([
        f.freezer.freezeSelectedReference(f.project.actor, f.input, signal()),
        other.freezeSelectedReference(f.project.actor, f.input, signal()),
      ]);
      assert.equal(
        outcomes.filter((x) => x.disposition === "created").length,
        1,
      );
      assert.deepEqual(outcomes[0]!.record, outcomes[1]!.record);
      assert.equal(readdirSync(f.root).length, 2);
      assert.ok(f.state.gets >= 1 && f.state.gets <= 2);
      assert.deepEqual(await f.project.rows(), before);
    },
  );
  test(
    `${backend} project read and source GET grants cannot substitute for archive capture permission`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      f.state.freezeAllowed = false;
      await assert.rejects(
        f.freezer.freezeSelectedReference(f.project.actor, f.input, signal()),
        /freeze_denied/u,
      );
      assert.equal(f.state.gets, 0);
      assert.deepEqual(readdirSync(f.root), []);
      f.state.freezeAllowed = true;
      f.state.readAllowed = false;
      await assert.rejects(
        f.freezer.freezeSelectedReference(f.project.actor, f.input, signal()),
        /read_denied/u,
      );
      assert.equal(f.state.gets, 0);
      assert.deepEqual(readdirSync(f.root), []);
      f.state.readAllowed = true;
      f.state.afterGet = async () => {
        f.state.freezeAllowed = false;
      };
      await assert.rejects(
        f.freezer.freezeSelectedReference(f.project.actor, f.input, signal()),
        /freeze_denied/u,
      );
      assert.equal(f.state.gets, 1);
      assert.deepEqual(readdirSync(f.root), []);
    },
  );
  test(
    `${backend} capture rechecks adopted source after GET and after archive write; stale bytes are not returned as current`,
    assetTestOptions(backend),
    async (t) => {
      const duringRead = await fixture(t, backend);
      duringRead.state.afterGet = async () => {
        await duringRead.project.assets.setLocked(duringRead.project.actor, {
          projectId: duringRead.project.query.projectId,
          assetId: duringRead.project.query.assetId,
          expectedAssetRevision: 4,
          locked: true,
          idempotencyKey: "change-during-source-read",
        });
      };
      await assert.rejects(
        duringRead.freezer.freezeSelectedReference(
          duringRead.project.actor,
          duringRead.input,
          signal(),
        ),
        /reference_image_changed/u,
      );
      assert.deepEqual(readdirSync(duringRead.root), []);
      const f = await fixture(t, backend);
      f.state.afterSave = async () => {
        await f.project.assets.setLocked(f.project.actor, {
          projectId: f.project.query.projectId,
          assetId: f.project.query.assetId,
          expectedAssetRevision: 4,
          locked: true,
          idempotencyKey: "change-during-freeze",
        });
      };
      await assert.rejects(
        f.freezer.freezeSelectedReference(f.project.actor, f.input, signal()),
        /reference_image_changed/u,
      );
      assert.equal(f.state.gets, 1);
      assert.equal(readdirSync(f.root).length, 2);
      await assert.rejects(
        f.freezer.readFrozenReference(f.project.actor, f.input, signal()),
        /reference_image_changed/u,
      );
      assert.equal(f.state.gets, 1);
      const changed = {
        ...f.input,
        query: { ...f.input.query, expectedAssetRevision: 5 },
      };
      await assert.rejects(
        f.freezer.freezeSelectedReference(f.project.actor, changed, signal()),
        /idempotency_conflict/u,
      );
      assert.equal(f.state.gets, 1);
    },
  );
  test(
    `${backend} revoked project or archive permission after durable save leaves original bytes inaccessible`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      f.state.afterSave = async () => {
        f.project.policy.allow = false;
      };
      await assert.rejects(
        f.freezer.freezeSelectedReference(f.project.actor, f.input, signal()),
        /authorization_denied/u,
      );
      assert.equal(readdirSync(f.root).length, 2);
      await assert.rejects(
        f.freezer.readFrozenReference(f.project.actor, f.input, signal()),
        /authorization_denied/u,
      );
      assert.equal(f.state.gets, 1);
      f.project.policy.allow = true;
      f.state.freezeAllowed = false;
      await assert.rejects(
        f.freezer.readFrozenReference(f.project.actor, f.input, signal()),
        /freeze_denied/u,
      );
      assert.equal(f.state.gets, 1);
      const revokedCapture = await fixture(t, backend);
      revokedCapture.state.afterSave = async () => {
        revokedCapture.state.freezeAllowed = false;
      };
      await assert.rejects(
        revokedCapture.freezer.freezeSelectedReference(
          revokedCapture.project.actor,
          revokedCapture.input,
          signal(),
        ),
        /freeze_denied/u,
      );
      assert.equal(readdirSync(revokedCapture.root).length, 2);
      await assert.rejects(
        revokedCapture.freezer.readFrozenReference(
          revokedCapture.project.actor,
          revokedCapture.input,
          signal(),
        ),
        /freeze_denied/u,
      );
    },
  );
  test(
    `${backend} damaged or missing frozen bytes never cause a read-only lookup to repair or re-fetch supplier output`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      await assert.rejects(
        f.freezer.readFrozenReference(f.project.actor, f.input, signal()),
        /archive_missing/u,
      );
      assert.equal(f.state.gets, 0);
      const first = await f.freezer.freezeSelectedReference(
          f.project.actor,
          f.input,
          signal(),
        ),
        file = path.join(f.root, `${first.record.materialId}.crwpm`),
        bytes = readFileSync(file);
      bytes[bytes.length - 1] ^= 1;
      writeFileSync(file, bytes, { mode: 0o600 });
      await assert.rejects(
        f.freezer.readFrozenReference(f.project.actor, f.input, signal()),
        /ciphertext_invalid/u,
      );
      await assert.rejects(
        f.freezer.freezeSelectedReference(f.project.actor, f.input, signal()),
        /ciphertext_invalid/u,
      );
      assert.equal(f.state.gets, 1);
      assert.deepEqual(readFileSync(file), bytes);
      rmSync(file);
      f.state.bytes = materialPng(3, 1);
      await assert.rejects(
        f.freezer.freezeSelectedReference(f.project.actor, f.input, signal()),
        /content_missing/u,
      );
      await assert.rejects(
        f.freezer.readFrozenReference(f.project.actor, f.input, signal()),
        /content_missing/u,
      );
      assert.equal(f.state.gets, 1);
    },
  );
  test(
    `${backend} arbitrary URLs, accessors and pre-cancelled capture cannot dispatch or create an archive`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      let evaluated = 0;
      await assert.rejects(
        f.freezer.freezeSelectedReference(
          f.project.actor,
          { ...f.input, url: "https://elsewhere.example/" } as never,
          signal(),
        ),
      );
      const getter = {
        query: f.input.query,
        get idempotencyKey() {
          evaluated++;
          return "fake";
        },
      };
      await assert.rejects(
        f.freezer.freezeSelectedReference(f.project.actor, getter, signal()),
      );
      const proxy = new Proxy(f.input, {
        ownKeys() {
          evaluated++;
          throw new Error("trap");
        },
      });
      await assert.rejects(
        f.freezer.freezeSelectedReference(f.project.actor, proxy, signal()),
      );
      assert.equal(evaluated, 0);
      await assert.rejects(
        f.freezer.freezeSelectedReference(f.project.actor, f.input, {
          signal: AbortSignal.abort(new Error("named_cancelled")),
        }),
        /named_cancelled/u,
      );
      assert.equal(f.state.gets, 0);
      assert.deepEqual(readdirSync(f.root), []);
    },
  );
  test(
    `${backend} archive DTOs and overridden reader methods cannot replace the actual source-byte capture`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      Object.defineProperty(f.reader, "readSelectedReferenceBytes", {
        value: async () => {
          throw new Error("instance override must not execute");
        },
      });
      const first = await f.freezer.freezeSelectedReference(
        f.project.actor,
        f.input,
        signal(),
      );
      assert.equal(first.disposition, "created");
      const raw = await f.archive.load(first.record.request);
      assert.ok(raw);
      const forged = f.openFreezer({
        archiveId: f.archive.archiveId,
        load: async () => ({
          ...raw,
          record: {
            ...raw.record,
            source: {
              ...raw.record.source,
              resultLinkDigest: `sha256:${"f".repeat(64)}`,
            },
          },
        }),
        save: async () => {
          throw new Error("no save");
        },
      });
      await assert.rejects(
        forged.readFrozenReference(f.project.actor, f.input, signal()),
        /source_changed/u,
      );
      const badBytes = f.openFreezer({
        archiveId: f.archive.archiveId,
        load: async () => ({
          ...raw,
          bytes: materialPng(3, 1),
        }),
        save: async () => {
          throw new Error("no save");
        },
      });
      await assert.rejects(
        badBytes.readFrozenReference(f.project.actor, f.input, signal()),
        /bytes_invalid/u,
      );
      assert.equal(f.state.gets, 1);
    },
  );
}
function signal() {
  return { signal: new AbortController().signal };
}
async function fixture(t: TestContext, backend: "sqlite" | "postgres") {
  const project = await projectAssetReferenceImageFixture(t, backend),
    root = mkdtempSync(path.join(tmpdir(), "crewon-project-freeze-")),
    stores: FilesystemProjectMaterialArchive[] = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const config = {
    archiveId: "project-source-archive",
    rootDirectory: root,
    encryptionKey: Buffer.alloc(32, 71),
    keyId: "named-project-test-key",
  };
  const state: {
    bytes: Buffer;
    gets: number;
    readAllowed: boolean;
    freezeAllowed: boolean;
    afterGet?: () => Promise<void>;
    afterSave?: () => Promise<void>;
  } = { bytes: materialPng(), gets: 0, readAllowed: true, freezeAllowed: true };
  const grants: Parameters<
    ProjectReferenceMaterialFreezeAuthorizationPort["authorize"]
  >[0][] = [];
  const reader = new ProjectReferenceMaterialReader({
    sources: project.resolver(),
    adapter: {
      deriveReadDestination(source) {
        const url = new URL(source.resultLink.image.url);
        return {
          origin: url.origin + "/",
          path: url.pathname + url.search,
          output: {
            filename: source.resultLink.image.filename,
            subfolder: "named-fixture",
            type: "output",
          },
        };
      },
    },
    authorization: {
      authorize: async () =>
        state.readAllowed
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "named_read_denied" },
    },
    clock: { now: () => "2026-10-06T08:00:00.000Z" },
    dns: { resolveAll: async () => [{ address: "8.8.8.8", family: 4 }] },
    transport: {
      request: async () => {
        state.gets++;
        const body = Buffer.from(state.bytes);
        await state.afterGet?.();
        return { status: 200, headers: { "content-type": "image/png" }, body };
      },
    },
  });
  const openArchive = () => {
      const store = new FilesystemProjectMaterialArchive(config);
      stores.push(store);
      return store;
    },
    archive = openArchive();
  const openFreezer = (provided?: ProjectReferenceMaterialArchivePort) => {
    const store = provided ?? openArchive();
    return new ProjectReferenceMaterialFreezer({
      sources: project.resolver(),
      reader,
      archive: {
        archiveId: store.archiveId,
        load: store.load.bind(store),
        save: async (input) => {
          const result = await store.save(input);
          await state.afterSave?.();
          return result;
        },
      },
      authorization: {
        authorize: async (grant) => {
          grants.push(grant);
          return state.freezeAllowed
            ? { outcome: "allow" }
            : { outcome: "deny", reasonCode: "named_archive_denied" };
        },
      },
    });
  };
  const input = {
    query: project.query,
    idempotencyKey: "original-source-freeze",
  };
  return {
    project,
    root,
    state,
    archive,
    reader,
    openFreezer,
    freezer: openFreezer(archive),
    input,
    grants,
  };
}
