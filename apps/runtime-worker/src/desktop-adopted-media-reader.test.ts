import { createNativeProjectMediaInputTools } from "./plugins/native-project-media-input-runtime.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopAdoptedMediaReader } from "@crewon/media-runtime/desktop-adopted-media-reader";
import { loadDesktopProjectResultArchive } from "@crewon/media-runtime/desktop-project-result-archive";
import { adoptedMediaReaderFixture } from "./project-adopted-media-reference-reader.test-support.ts";
// Saved bytes originate in the installed T10 handler and original SQL adoption.
// Provider sockets and actor-current callbacks are named fixture ports.
test(
  "native saved-result reader reopens the shared encrypted archive, reuses adopted output, and revokes retained readers on close",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "crewon-native-adopted-reader-"));
    const key = join(root, "master.key");
    await writeFile(key, Buffer.alloc(32, 97), { mode: 0o600 });
    const storage = {
      artifactRoot: join(root, "artifacts"),
      encryptionKeyPath: key,
      encryptionKeyId: "named-native-master",
    };
    const f = await adoptedMediaReaderFixture(t, "sqlite", {
      archiveConfiguration: (scope) =>
        loadDesktopProjectResultArchive(storage, scope),
    });
    let active = true,
      checks = 0;
    const controller = new AbortController();
    const open = () =>
      createDesktopAdoptedMediaReader({
        store: f.parent,
        storage,
        scope: {
          tenantId: f.target.installation.tenantId,
          spaceId: f.target.installation.spaceId,
          profileId: f.target.installation.profileId,
        },
        reviews: f.reviews.map(({ targetIdentity, workflow }) => ({
          targetIdentity,
          workflow,
        })),
        materialArchiveId: "native-material-archive",
        clock: { now: () => f.at },
        signal: controller.signal,
        assertCurrent: async (actor) => {
          checks++;
          assert.deepEqual(actor, f.actor);
          if (!active) throw new Error("named_native_owner_retired");
        },
        assertActive: (actor) => {
          assert.deepEqual(actor, f.actor);
          if (!active) throw new Error("named_native_owner_retired");
        },
      });
    const owners: Awaited<ReturnType<typeof open>>[] = [];
    t.after(async () => {
      for (const owner of owners) await owner.close();
      f.archiveConfig.encryptionKey.fill(0);
      await rm(root, { recursive: true, force: true });
    });
    const first = await open();
    owners.push(first);
    const reader = f.readers(f.store, f.parent, first.config.results).reader;
    const io = [f.state.gets, ...f.materialCounts()];
    const read = await reader.readSelectedReferenceBytes(
      f.actor,
      f.referenceQuery,
      { signal: controller.signal },
    );
    assert.deepEqual(Buffer.from(read.bytes), f.state.bytes);
    assert.equal(read.source.candidate.candidateId, f.candidate.candidateId);
    assert.ok(checks > 0);
    assert.deepEqual([f.state.gets, ...f.materialCounts()], io);
    await assert.rejects(
      first.config.results.publish(f.actor, f.query, {
        signal: controller.signal,
      }),
      /read_only/,
    );
    await first.close();
    await assert.rejects(
      reader.readSelectedReferenceBytes(f.actor, f.referenceQuery, {
        signal: controller.signal,
      }),
    );
    const cold = await open();
    owners.push(cold);
    const reread = await f
      .readers(f.store, f.parent, cold.config.results)
      .reader.readSelectedReferenceBytes(f.actor, f.referenceQuery, {
        signal: controller.signal,
      });
    assert.deepEqual(reread.bytes, read.bytes);
    const target = f.reviews[0]!.targetIdentity;
    const scope = {
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      profileId: f.target.installation.profileId,
    };
    const publication = {
      pluginId: target.pluginId,
      packageDigest: target.packageDigest,
      contributionId: "workbench",
    };
    const projects = {
      version: "crewon.desktop-project-execution.v1" as const,
      mediaInputStages: {
        version: "crewon.project-media-input-stages.v1" as const,
        publications: [publication],
      },
      mediaInputs: {
        version: "crewon.desktop-project-media-inputs.v1" as const,
        purposes: ["read", "write"] as const,
        reviews: f.reviews.map(({ targetIdentity, workflow }) => ({
          targetIdentity,
          workflow,
        })),
        referenceIdentities: [
          {
            pluginId: "crewon.short-drama" as const,
            pluginVersion: target.version,
            manifestDigest: target.manifestDigest,
            implementationDigest: target.implementationDigest,
          },
        ],
      },
    };
    const native = (v2: boolean) =>
      createNativeProjectMediaInputTools({
        projects: {
          ...projects,
          ...(v2
            ? {
                assetV2: {
                  version: "crewon.desktop-project-assets.v2" as const,
                  publications: [publication],
                },
              }
            : {}),
        },
        scope,
        packages: [target],
        current: () => {
          if (!active) throw new Error("named_native_owner_retired");
        },
        actor: (value) => {
          assert.deepEqual(value, f.actor);
          return f.actor;
        },
        operate: async (work) => work(),
      })!.createInputs({ store: f.parent });
    const command = {
      ...f.command,
      references: { character: f.referenceQuery },
      idempotencyKey: "native-saved-t10-input",
    };
    await assert.rejects(native(false).saveInput(f.actor, command));
    const saved = await native(true).saveInput(f.actor, command);
    assert.equal(saved.input.schemaVersion, "crewon.project-media-input.v2");
    assert.ok("media" in saved.input.references[0]!);
    active = false;
    await assert.rejects(
      cold.config.results.readCandidate(f.actor, f.query, {
        signal: controller.signal,
      }),
      /named_native_owner_retired/,
    );
    assert.deepEqual([f.state.gets, ...f.materialCounts()], io);
  },
);
