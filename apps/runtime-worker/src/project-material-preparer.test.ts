import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createExtensionConfiguration } from "@crewon/domain";
import {
  ProjectMaterialTargetApplicationService,
  parseProjectMaterialPreparationInitial,
} from "@crewon/application";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { selectionRecipe } from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import { observeMaterialPreparationSql } from "../../../packages/store/src/project-material-preparation.test-support.ts";
import { ProjectMaterialPreparer } from "./project-material-preparer.ts";
import {
  projectMaterialPreparerFixture as fixture,
  materialSignal as signal,
} from "./project-material-preparer.test-support.ts";
import { materialPng } from "./project-material-png.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend} real preparation composes source archive, target snapshots, one SQL claim and exact target PNG`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.rows();
      f.state.onPost = async () => {
        const claimed = await f.journal.load(f.request, f.authority());
        assert.equal(claimed?.event.phase, "dispatching");
        assert.equal(claimed?.event.revision, 2);
      };
      const first = await f.preparer.prepareSelectedReference(
        f.actor,
        f.input,
        signal(),
      );
      assert.equal(first.disposition, "verified");
      assert.equal(first.state.event.phase, "verified");
      assert.equal(first.state.event.revision, 3);
      assert.equal(
        first.observation?.byteDigest,
        first.state.initial.source.source.byteDigest,
      );
      assert.equal(
        first.state.initial.target.package.packageDigest,
        f.target.package.packageDigest,
      );
      assert.equal(first.state.initial.source.archiveId, f.archive.archiveId);
      assert.equal(f.state.sourceGets, 1);
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.targetGets, 1);
      assert.equal(readdirSync(f.root).length, 2);
      assert.ok(
        f.state.grants.some(
          (g) =>
            g.action === "projectMaterial:upload" &&
            g.resource.transferRequestDigest ===
              first.state.initial.transfer.requestDigest,
        ),
      );
      const second = await f.preparer.prepareSelectedReference(
        f.actor,
        f.input,
        signal(),
      );
      assert.equal(second.disposition, "verified");
      assert.deepEqual(second.state, first.state);
      assert.notEqual(
        second.observation!.checkedAt,
        first.observation!.checkedAt,
      );
      assert.equal(f.state.sourceGets, 1);
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.targetGets, 2);
      assert.deepEqual(await f.rows(), before);
      assert.deepEqual(await f.journalCounts(), {
        project_material_preparations: 1,
        project_material_preparation_events: 3,
        project_material_preparation_heads: 1,
      });
    },
  );
  test(
    `${backend} two independent preparers converge on the original UUID and only the claim owner uploads`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        other = await f.cold(),
        before = await f.rows();
      const results = await Promise.all([
        f.preparer.prepareSelectedReference(f.actor, f.input, signal()),
        other.preparer.prepareSelectedReference(f.actor, f.input, signal()),
      ]);
      assert.equal(f.state.uploads, 1);
      assert.equal(
        results[0]!.state.initial.transfer.preparationId,
        results[1]!.state.initial.transfer.preparationId,
      );
      assert.equal(
        results[0]!.state.initial.transfer.requestDigest,
        results[1]!.state.initial.transfer.requestDigest,
      );
      const final = await other.preparer.observePreparedReference(
        f.actor,
        f.input,
        signal(),
      );
      assert.equal(final.disposition, "verified");
      assert.equal(f.state.uploads, 1);
      assert.ok(f.state.sourceGets >= 1 && f.state.sourceGets <= 2);
      assert.deepEqual(await f.rows(), before);
    },
  );
  test(
    `${backend} accepted upload with lost acknowledgement recovers by GET after actual parent/archive close`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      f.state.onPost = async () => {
        throw new Error("transport_failed");
      };
      const pending = await f.preparer.prepareSelectedReference(
        f.actor,
        f.input,
        signal(),
      );
      assert.equal(pending.disposition, "pending");
      assert.equal(pending.state.event.phase, "unknownOutcome");
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.targetGets, 0);
      f.archive.close();
      await f.parent.close();
      f.state.onPost = undefined;
      f.state.bytes = materialPng(3, 1);
      const cold = await f.cold(),
        result = await cold.preparer.observePreparedReference(
          f.actor,
          f.input,
          signal(),
        );
      assert.equal(result.disposition, "verified");
      assert.equal(result.state.event.revision, 4);
      assert.deepEqual(result.state.initial, pending.state.initial);
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.sourceGets, 1);
      assert.equal(f.state.targetGets, 1);
    },
  );
  test(
    `${backend} a crash fence after durable claim leaves dispatching and cold preparation cannot POST again`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      f.state.onAuthorize = async ({ action }) => {
        if (action !== "projectMaterial:upload") return;
        if (
          (await f.journal.load(f.request, f.authority()))?.event.phase ===
          "dispatching"
        )
          f.state.uploadAllowed = false;
      };
      await assert.rejects(
        f.preparer.prepareSelectedReference(f.actor, f.input, signal()),
        /preparation_denied/u,
      );
      assert.equal(
        (await f.journal.load(f.request, f.authority()))?.event.phase,
        "dispatching",
      );
      assert.equal(f.state.uploads, 0);
      f.state.onAuthorize = undefined;
      f.state.uploadAllowed = true;
      f.archive.close();
      await f.parent.close();
      const next = await f.cold(),
        result = await next.preparer.prepareSelectedReference(
          f.actor,
          f.input,
          signal(),
        );
      assert.equal(result.disposition, "pending");
      assert.equal(result.state.event.phase, "unknownOutcome");
      assert.equal(f.state.uploads, 0);
      assert.equal(f.state.sourceGets, 1);
      assert.equal(f.state.targetGets, 1);
    },
  );
  test(
    `${backend} losing or corrupting archived bytes never repairs a known preparation from mutable source`,
    assetTestOptions(backend),
    async (t) => {
      for (const damage of [
        "bytes-missing",
        "bytes-corrupt",
        "whole-archive",
      ] as const) {
        const f = await fixture(t, backend),
          original = await f.preparer.prepareSelectedReference(
            f.actor,
            f.input,
            signal(),
          );
        const file = join(
          f.root,
          `${original.state.initial.source.materialId}.crwpm`,
        );
        f.archive.close();
        await f.parent.close();
        if (damage === "bytes-missing") rmSync(file);
        else if (damage === "bytes-corrupt")
          writeFileSync(file, Buffer.from("damaged archive"));
        else for (const name of readdirSync(f.root)) rmSync(join(f.root, name));
        const next = await f.cold();
        await assert.rejects(
          next.preparer.prepareSelectedReference(f.actor, f.input, signal()),
          /archive_/u,
        );
        assert.equal(f.state.sourceGets, 1);
        assert.equal(f.state.uploads, 1);
        assert.equal(f.state.targetGets, 1);
      }
    },
  );
  test(
    `${backend} independent prepare/upload/observe grants are mandatory; source/read access cannot substitute`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      f.state.prepareAllowed = false;
      await assert.rejects(
        f.preparer.prepareSelectedReference(f.actor, f.input, signal()),
        /preparation_denied/u,
      );
      assert.equal(f.state.sourceGets, 0);
      assert.equal(f.state.uploads, 0);
      assert.equal(readdirSync(f.root).length, 0);
      f.state.prepareAllowed = true;
      f.state.uploadAllowed = false;
      await assert.rejects(
        f.preparer.prepareSelectedReference(f.actor, f.input, signal()),
        /preparation_denied/u,
      );
      assert.equal(
        (await f.journal.load(f.request, f.authority()))?.event.phase,
        "reserved",
      );
      assert.equal(f.state.uploads, 0);
      f.state.uploadAllowed = true;
      f.state.observeAllowed = false;
      await assert.rejects(
        f.preparer.prepareSelectedReference(f.actor, f.input, signal()),
        /preparation_denied/u,
      );
      assert.equal(
        (await f.journal.load(f.request, f.authority()))?.event.phase,
        "dispatching",
      );
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.targetGets, 0);
      f.state.observeAllowed = true;
      assert.equal(
        (await f.preparer.observePreparedReference(f.actor, f.input, signal()))
          .disposition,
        "verified",
      );
      assert.equal(f.state.uploads, 1);
    },
  );
  test(
    `${backend} exact target bytes and acknowledgement are required; terminal rejection never repairs by upload`,
    assetTestOptions(backend),
    async (t) => {
      const mismatch = await fixture(t, backend);
      mismatch.state.onGet = async () => {
        for (const key of mismatch.state.files.keys())
          mismatch.state.files.set(key, materialPng(3, 1));
      };
      const rejected = await mismatch.preparer.prepareSelectedReference(
        mismatch.actor,
        mismatch.input,
        signal(),
      );
      assert.equal(rejected.disposition, "rejected");
      assert.equal(rejected.observation, null);
      mismatch.state.onGet = undefined;
      assert.equal(
        (
          await mismatch.preparer.prepareSelectedReference(
            mismatch.actor,
            mismatch.input,
            signal(),
          )
        ).disposition,
        "rejected",
      );
      assert.equal(mismatch.state.uploads, 1);
      assert.equal(mismatch.state.targetGets, 1);
      const renamed = await fixture(t, backend);
      renamed.state.reply = (response) => ({
        ...response,
        body: Buffer.from(
          JSON.stringify({
            ...JSON.parse(Buffer.from(response.body).toString()),
            name: "renamed.png",
          }),
        ),
      });
      const result = await renamed.preparer.prepareSelectedReference(
        renamed.actor,
        renamed.input,
        signal(),
      );
      assert.equal(result.disposition, "rejected");
      assert.equal(result.state.event.failureCode, "target_identity_changed");
      assert.equal(renamed.state.targetGets, 0);
      assert.equal(renamed.state.uploads, 1);
    },
  );
  test(
    `${backend} past verified observation cannot claim current readiness after target disappears or mutates`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        first = await f.preparer.prepareSelectedReference(
          f.actor,
          f.input,
          signal(),
        );
      f.state.files.clear();
      const missing = await f.preparer.observePreparedReference(
        f.actor,
        f.input,
        signal(),
      );
      assert.equal(missing.disposition, "pending");
      assert.equal(missing.observation, null);
      assert.deepEqual(missing.state, first.state);
      const path = `/view?${new URLSearchParams(first.state.initial.transfer.output)}`;
      f.state.files.set(path, materialPng(3, 1));
      const changed = await f.preparer.prepareSelectedReference(
        f.actor,
        f.input,
        signal(),
      );
      assert.equal(changed.disposition, "pending");
      assert.equal(changed.observation, null);
      assert.deepEqual(changed.state, first.state);
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.sourceGets, 1);
    },
  );
  test(
    `${backend} source/project and installation changes after POST retain original dispatch without reporting verified`,
    assetTestOptions(backend),
    async (t) => {
      for (const change of ["source", "project", "installation"] as const) {
        const f = await fixture(t, backend);
        f.state.onPost = async () => {
          if (change === "source")
            await f.assets.setLocked(f.actor, {
              projectId: f.query.projectId,
              assetId: f.query.assetId,
              expectedAssetRevision: 4,
              locked: true,
              idempotencyKey: "source-changed-after-upload",
            });
          else if (change === "project") f.policy.allow = false;
          else
            await f.installs.commitSelection(
              selectionRecipe(f.enabled.selection, "disable-after-upload", {
                actor: f.actor,
                state: "disabled",
              }),
            );
        };
        await assert.rejects(
          f.preparer.prepareSelectedReference(f.actor, f.input, signal()),
          /reference_image_changed|authorization_denied|target_selection_unavailable/u,
        );
        assert.equal(f.state.uploads, 1);
        assert.equal(f.state.targetGets, 0);
        assert.deepEqual(await f.headPhases(), ["dispatching"]);
        await assert.rejects(
          f.preparer.prepareSelectedReference(f.actor, f.input, signal()),
        );
        assert.equal(f.state.uploads, 1);
        assert.equal(f.state.sourceGets, 1);
      }
    },
  );
  test(
    `${backend} host profile, installation/config reads and exact reviewed package are independently required`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      f.state.installationAllowed = false;
      await assert.rejects(
        f.preparer.prepareSelectedReference(f.actor, f.input, signal()),
        /authorization_denied/u,
      );
      f.state.installationAllowed = true;
      f.state.configurationAllowed = false;
      await assert.rejects(
        f.preparer.prepareSelectedReference(f.actor, f.input, signal()),
        /authorization_denied/u,
      );
      f.state.configurationAllowed = true;
      const unreviewed = f.open(f.parent, [
        { ...f.reviewedTarget, packageDigest: `sha256:${"e".repeat(64)}` },
      ]);
      await assert.rejects(
        unreviewed.preparer.prepareSelectedReference(
          f.actor,
          f.input,
          signal(),
        ),
        /target_unreviewed/u,
      );
      await assert.rejects(
        f.targets.resolveTarget({
          ...f.request,
          target: { ...f.request.target, profileId: "client-selected-profile" },
        }),
        /selection_unavailable/u,
      );
      assert.equal(f.state.sourceGets, 0);
      assert.equal(f.state.uploads, 0);
      assert.equal(readdirSync(f.root).length, 0);
    },
  );
  test(
    `${backend} new default configuration does not rebind original origin or preparation key`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        first = await f.preparer.prepareSelectedReference(
          f.actor,
          f.input,
          signal(),
        );
      const { contentDigest: ignored, ...body } = f.target.configuration;
      const next = createExtensionConfiguration(
        {
          ...body,
          revision: 2,
          parameters: {
            ...body.parameters,
            baseUrl: "https://new-target.provider.example/",
          },
        },
        f.digester,
      );
      await f.first.store.saveExtensionConfiguration({
        configuration: next,
        expectedRevision: 1,
        receipt: {
          actorId: f.actor.actorId,
          idempotencyKey: "new-default-target",
          requestDigest: f.digester.sha256("new-default-target"),
        },
      });
      const restored = await f.preparer.observePreparedReference(
        f.actor,
        f.input,
        signal(),
      );
      assert.equal(restored.disposition, "verified");
      assert.deepEqual(restored.state.initial, first.state.initial);
      assert.equal(
        f.state.requests.at(-1)!.target.endpoint.origin + "/",
        first.state.initial.transfer.origin,
      );
      await assert.rejects(
        f.preparer.prepareSelectedReference(
          f.actor,
          {
            ...f.input,
            target: { ...f.input.target, configurationRevision: 2 },
          },
          signal(),
        ),
        /idempotency_conflict/u,
      );
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.sourceGets, 1);
    },
  );
  test(
    `${backend} actual journal/freezer/target instance overrides cannot fabricate preparation or bypass reads`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      for (const [object, keys] of [
        [f.journal, ["load", "reserve", "claimDispatch", "advance"]],
        [f.freezer, ["freezeSelectedReference", "readFrozenReference"]],
        [f.targets, ["resolveTarget"]],
        [f.installations, ["getSelection", "getPackage"]],
        [f.configurations, ["getConfiguration"]],
      ] as const) {
        for (const key of keys)
          Object.defineProperty(object, key, {
            get() {
              throw new Error("instance override evaluated");
            },
          });
      }
      const bound = new ProjectMaterialPreparer(f.dependencies);
      assert.equal(
        (await bound.prepareSelectedReference(f.actor, f.input, signal()))
          .disposition,
        "verified",
      );
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.sourceGets, 1);
      assert.throws(
        () =>
          new ProjectMaterialPreparer({
            ...f.dependencies,
            journal: {
              load: async () => null,
              reserve: async () => {
                throw 0;
              },
              claimDispatch: async () => {
                throw 0;
              },
              advance: async () => {
                throw 0;
              },
            },
          }),
        /journal_invalid/u,
      );
      assert.throws(
        () =>
          new ProjectMaterialTargetApplicationService({
            installations: {} as never,
            configurations: f.configurations,
          }),
        /dependency_invalid/u,
      );
    },
  );
  test(
    `${backend} purpose activity revocation inside actual SQL claim rolls back and prevents transport`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      f.state.uploadAllowed = false;
      await assert.rejects(
        f.preparer.prepareSelectedReference(f.actor, f.input, signal()),
        /preparation_denied/u,
      );
      f.state.uploadAllowed = true;
      const restore = observeMaterialPreparationSql(
        backend,
        /INSERT INTO .*project_material_preparation_events/u,
        () => {
          f.state.active = false;
        },
      );
      try {
        await assert.rejects(
          f.preparer.prepareSelectedReference(f.actor, f.input, signal()),
          /owner_retired/u,
        );
      } finally {
        restore();
      }
      assert.equal(f.state.uploads, 0);
      assert.equal(
        (await f.journal.load(f.request, f.authority()))?.event.phase,
        "reserved",
      );
      assert.deepEqual(await f.journalCounts(), {
        project_material_preparations: 1,
        project_material_preparation_events: 1,
        project_material_preparation_heads: 1,
      });
    },
  );
  test(
    `${backend} query-only missing preparation does no capture or I/O; requests reject paths and accessors before await`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      await assert.rejects(
        f.preparer.observePreparedReference(f.actor, f.input, signal()),
        /not_found/u,
      );
      await assert.rejects(async () =>
        f.preparer.prepareSelectedReference(
          f.actor,
          { ...f.input, url: "https://caller.example/" } as never,
          signal(),
        ),
      );
      let reads = 0;
      const invalid = {
        ...f.input,
        source: {
          ...f.input.source,
          query: {
            ...f.input.source.query,
            get assetId() {
              reads++;
              return "other";
            },
          },
        },
      };
      await assert.rejects(async () =>
        f.preparer.prepareSelectedReference(f.actor, invalid, signal()),
      );
      const proxy = new Proxy(f.input.target, {
        ownKeys() {
          reads++;
          throw 0;
        },
      });
      await assert.rejects(async () =>
        f.preparer.prepareSelectedReference(
          f.actor,
          { ...f.input, target: proxy },
          signal(),
        ),
      );
      assert.equal(reads, 0);
      assert.equal(f.state.sourceGets, 0);
      assert.equal(f.state.uploads, 0);
      assert.equal(f.state.targetGets, 0);
    },
  );
  test(
    `${backend} private request snapshot survives caller mutation and policy baseline rejects private upload DNS`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        input = structuredClone(f.input);
      const preparing = f.preparer.prepareSelectedReference(
        f.actor,
        input,
        signal(),
      );
      Object.assign(input.source.query, { assetId: "changed-by-caller" });
      Object.assign(input.target, { configurationRevision: 99 });
      Object.assign(input, { idempotencyKey: "changed-key" });
      const result = await preparing;
      assert.equal(result.disposition, "verified");
      assert.deepEqual(result.state.initial.request, f.request);
      const other = await fixture(t, backend),
        denied = new ProjectMaterialPreparer({
          ...other.dependencies,
          dns: {
            resolveAll: async () => [{ address: "127.0.0.1", family: 4 }],
          },
        });
      await assert.rejects(
        denied.prepareSelectedReference(other.actor, other.input, signal()),
        /network_egress_denied/u,
      );
      assert.equal(other.state.uploads, 0);
      assert.equal(
        (await other.journal.load(other.request, other.authority()))?.event
          .phase,
        "reserved",
      );
    },
  );
}

for (const protocol of ["workflow-panel-v1", "workflow-api-v1"] as const)
  test(`${protocol}: real v3 preparation retains the immutable input transfer on cold observe and never uploads twice`, async (t) => {
    const f = await fixture(t, "sqlite", { serviceProtocol: protocol });
    f.state.onPost = async () => {
      throw Error("named_response_lost_after_upload");
    };
    const first = await f.preparer.prepareSelectedReference(
      f.actor,
      f.input,
      signal(),
    );
    assert.equal(first.disposition, "pending");
    assert.equal(first.state.event.phase, "unknownOutcome");
    assert.equal(
      first.state.initial.schemaVersion,
      "crewon.project-material-preparation.v3",
    );
    assert.equal(
      first.state.initial.transfer.adapter,
      "comfyui-workflow-file-upload.v1",
    );
    assert.equal(first.state.initial.transfer.output.type, "input");
    assert.equal(f.state.uploads, 1);
    const cold = await f.cold();
    const observed = await cold.preparer.observePreparedReference(
      f.actor,
      f.input,
      signal(),
    );
    assert.equal(observed.disposition, "verified");
    assert.deepEqual(observed.state.initial, first.state.initial);
    assert.equal(observed.state.event.phase, "verified");
    await cold.preparer.prepareSelectedReference(f.actor, f.input, signal());
    assert.equal(f.state.uploads, 1);
    assert.equal(f.state.sourceGets, 1);
    const initial = observed.state.initial;
    for (const output of [
      { ...initial.transfer.output, type: "output" },
      { ...initial.transfer.output, filename: "foreign.png" },
    ]) {
      assert.throws(() =>
        parseProjectMaterialPreparationInitial({
          ...initial,
          transfer: { ...initial.transfer, output },
        }),
      );
    }
  });
