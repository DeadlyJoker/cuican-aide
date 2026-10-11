import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import {
  PluginUiApplicationService,
  capturePluginUiInvocationCommitAuthority,
  type PluginProjectReadScope,
} from "@crewon/application";
import { capturePluginProjectReadScope } from "../../application/src/plugin-project-read-scope.ts";
import {
  parsePluginPackageDescriptor,
  parsePluginUiJsonValue,
} from "@crewon/contracts/plugins";
import {
  uiTestDescriptor,
  uiTestBytes,
} from "../../application/src/plugin-ui.test-support.ts";
import { ownedConversationSqlFixture } from "./project-conversation-owned.test-support.ts";
import { creationRecipe } from "./creative-project-store.test-support.ts";
import { pluginProjectMetadataOwnerColumns } from "./plugin-project-metadata-owner-records.ts";

test(
  "postgres: original installed UI reads all eight protected project views through original queries and refuses detached readers",
  {
    skip: !process.env.CREWON_TEST_POSTGRES_URL,
  },
  async (t) => {
    const f = await ownedConversationSqlFixture(t, "postgres");
    const store = f.parent.creativeProjectStore();
    const observer = new Pool({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
    });
    t.after(() => observer.end());
    // Original project creation; protected ownership for these extra rows is an explicit persistent fixture.
    for (const [projectId, at, pluginId] of [
      ["owned-second", "2026-10-12T00:00:00.000Z", f.installation.pluginId],
      ["foreign-newer", "2026-10-13T00:00:00.000Z", "test.foreign"],
      ["legacy-newest", "2026-10-14T00:00:00.000Z", null],
    ] as const) {
      await store.commitProjectCreation(
        creationRecipe(projectId, projectId, f.actor, at),
      );
      if (pluginId === null) continue;
      const record = {
        schemaVersion: "crewon.plugin-project-metadata-owner.v1",
        owner: { ...f.namespaceOwner(projectId), pluginId },
        createdAt: at,
      };
      await observer.query(
        `INSERT INTO ${f.prefix}plugin_project_metadata_owners(${pluginProjectMetadataOwnerColumns.join(",")}) VALUES(${pluginProjectMetadataOwnerColumns.map((_, i) => `$${i + 1}`).join(",")})`,
        [
          record.owner.tenantId,
          record.owner.spaceId,
          record.owner.principalId,
          record.owner.actorId,
          record.owner.profileId,
          record.owner.pluginId,
          record.owner.publisherId,
          record.owner.projectId,
          at,
          JSON.stringify(record),
        ],
      );
    }
    const owner = {
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      principalId: f.actor.principalId,
    };
    const scope = {
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      profileId: f.installation.profileId,
    };
    const descriptor = parsePluginPackageDescriptor({
      ...uiTestDescriptor,
      pluginId: f.installation.pluginId,
      publisherId: f.installation.publisherId,
      version: f.installation.version,
      requires: [
        {
          service: "crewon.creative-projects",
          apiVersion: "1",
          optional: false,
        },
      ],
    });
    const retained: PluginProjectReadScope[] = [];
    const ui = new PluginUiApplicationService({
      store: f.installs,
      profiles: { resolve: async () => scope },
      authorization: {
        authorize: async () => ({
          outcome: "allow",
          authorityEpoch: "named-pg-read-epoch",
        }),
      },
      packages: {
        verify: async () => ({ descriptor, publicAssets: ["ui.mjs"] }),
        readAsset: async () => ({
          bytes: uiTestBytes,
          contentType: "text/javascript; charset=utf-8",
        }),
      },
      ids: { nextId: () => randomUUID().replaceAll("-", "").repeat(2) },
      clock: { now: () => f.namespaceRecipe().createdAt },
      actions: {
        async invoke(context) {
          const readScope = capturePluginProjectReadScope(
            context,
            capturePluginUiInvocationCommitAuthority(context),
          );
          retained.push(readScope);
          const projects = store.bindProjectReads(readScope);
          const input = context.input as {
            projectId: string;
            briefRevision: number;
            assetId: string;
            assetRevision: number;
            query: {
              afterBriefRevision: number;
              afterAssetId: string | null;
              afterAssetRevision: number;
              limit: number;
            };
          };
          if (context.action === "crewon.creative-projects.v1.listProjects") {
            await assert.rejects(
              projects.loadProject({ owner, projectId: f.reference.projectId }),
              /read_method_mismatch/,
            );
            const page = await projects.listProjects({
              owner,
              state: "all",
              after: null,
              limit: 1,
            });
            assert.deepEqual(
              page.projects.map((project) => project.projectId),
              ["owned-second"],
            );
            assert.deepEqual(page.next, {
              projectId: "owned-second",
              updatedAt: "2026-10-12T00:00:00.000Z",
            });
            const second = await projects.listProjects({
              owner,
              state: "all",
              after: page.next,
              limit: 1,
            });
            assert.deepEqual(
              second.projects.map((project) => project.projectId),
              [f.reference.projectId],
            );
            assert.equal(second.next, null);
            return parsePluginUiJsonValue(page);
          }
          const project = await projects.loadProject({
            owner,
            projectId: input.projectId,
          });
          assert.ok(project);
          if (context.action === "crewon.creative-projects.v1.getBrief") {
            const brief = await projects.loadBrief({
              owner,
              projectId: input.projectId,
              briefRevision: input.briefRevision,
            });
            assert.ok(brief);
            assert.equal(brief.projectId, project.projectId);
            return parsePluginUiJsonValue(brief);
          }
          if (context.action === "crewon.creative-projects.v1.listBriefs") {
            const briefs = await projects.listBriefs({
              owner,
              projectId: input.projectId,
              afterBriefRevision: input.query.afterBriefRevision,
              limit: input.query.limit,
            });
            assert.equal(briefs.length, 1);
            assert.equal(briefs[0]!.projectId, project.projectId);
            return parsePluginUiJsonValue(briefs);
          }
          if (
            context.action === "crewon.creative-projects.v1.getConceptAsset"
          ) {
            await assert.rejects(
              projects.loadConceptAsset({
                owner,
                projectId: input.projectId,
                assetId: "foreign-asset",
              }),
              /read_target_mismatch/,
            );
            const asset = await projects.loadConceptAsset({
              owner,
              projectId: input.projectId,
              assetId: input.assetId,
            });
            assert.equal(asset?.assetId, f.reference.assetId);
            return parsePluginUiJsonValue(asset);
          }
          if (
            context.action === "crewon.creative-projects.v1.listConceptAssets"
          ) {
            const assets = await projects.listConceptAssets({
              owner,
              projectId: input.projectId,
              afterAssetId: input.query.afterAssetId,
              limit: input.query.limit,
            });
            assert.deepEqual(
              assets.map((asset) => asset.assetId),
              [f.reference.assetId],
            );
            return parsePluginUiJsonValue(assets);
          }
          if (
            context.action === "crewon.creative-projects.v1.getConceptRevision"
          ) {
            await assert.rejects(
              projects.loadConceptRevision({
                owner,
                projectId: input.projectId,
                assetId: input.assetId,
                assetRevision: input.assetRevision + 1,
              }),
              /read_target_mismatch/,
            );
            const revision = await projects.loadConceptRevision({
              owner,
              projectId: input.projectId,
              assetId: input.assetId,
              assetRevision: input.assetRevision,
            });
            assert.equal(revision?.assetRevision, f.reference.assetRevision);
            return parsePluginUiJsonValue(revision);
          }
          if (
            context.action ===
            "crewon.creative-projects.v1.listConceptRevisions"
          ) {
            const revisions = await projects.listConceptRevisions({
              owner,
              projectId: input.projectId,
              assetId: input.assetId,
              afterAssetRevision: input.query.afterAssetRevision,
              limit: input.query.limit,
            });
            assert.deepEqual(
              revisions.map((revision) => revision.assetRevision),
              [f.reference.assetRevision],
            );
            return parsePluginUiJsonValue(revisions);
          }
          await assert.rejects(
            projects.loadBrief({
              owner,
              projectId: input.projectId,
              briefRevision: 1,
            }),
            /read_method_mismatch/,
          );
          return parsePluginUiJsonValue(project);
        },
      },
    });
    const lease = await ui.openMount(f.actor, {
      pluginId: f.installation.pluginId,
      contributionId: "workbench",
      expectedSelectionRevision: f.installation.selectionRevision,
      expectedPackageDigest: f.installation.packageDigest,
    });
    for (const [method, input] of [
      ["getProject", { projectId: f.reference.projectId }],
      ["listProjects", { query: { state: "all", cursor: null, limit: 16 } }],
      ["getBrief", { projectId: f.reference.projectId, briefRevision: 1 }],
      [
        "listBriefs",
        {
          projectId: f.reference.projectId,
          query: { afterBriefRevision: 0, limit: 16 },
        },
      ],
      [
        "getConceptAsset",
        { projectId: f.reference.projectId, assetId: f.reference.assetId },
      ],
      [
        "listConceptAssets",
        {
          projectId: f.reference.projectId,
          query: { afterAssetId: null, limit: 16 },
        },
      ],
      [
        "getConceptRevision",
        {
          projectId: f.reference.projectId,
          assetId: f.reference.assetId,
          assetRevision: f.reference.assetRevision,
        },
      ],
      [
        "listConceptRevisions",
        {
          projectId: f.reference.projectId,
          assetId: f.reference.assetId,
          query: { afterAssetRevision: 0, limit: 16 },
        },
      ],
    ] as const) {
      await ui.invoke(f.actor, {
        mountRef: lease.mountRef,
        action: `crewon.creative-projects.v1.${method}`,
        input: { ...input },
      });
    }
    for (const ref of retained) {
      assert.throws(() => store.bindProjectReads(ref), /unavailable/);
      assert.throws(() => store.bindProjectReads({ ...ref }), /unavailable/);
    }
    await assert.rejects(
      ui.invoke(f.actor, {
        mountRef: lease.mountRef,
        action: "crewon.creative-projects.v1.getProject",
        input: { projectId: "foreign-newer" },
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        error.cause.message === "creative_project_not_found",
    );
    const invalidId = "owned-invalid-lookahead";
    await store.commitProjectCreation(
      creationRecipe(invalidId, invalidId, f.actor, "2026-10-12T00:00:00.000Z"),
    );
    const invalidOwner = f.namespaceOwner(invalidId);
    const invalidRecord = {
      schemaVersion: "crewon.plugin-project-metadata-owner.v1",
      owner: invalidOwner,
      createdAt: "2026-13-01T00:00:00.000Z",
    };
    await observer.query(
      `INSERT INTO ${f.prefix}plugin_project_metadata_owners(${pluginProjectMetadataOwnerColumns.join(",")}) VALUES(${pluginProjectMetadataOwnerColumns.map((_, i) => `$${i + 1}`).join(",")})`,
      [
        invalidOwner.tenantId,
        invalidOwner.spaceId,
        invalidOwner.principalId,
        invalidOwner.actorId,
        invalidOwner.profileId,
        invalidOwner.pluginId,
        invalidOwner.publisherId,
        invalidId,
        invalidRecord.createdAt,
        JSON.stringify(invalidRecord),
      ],
    );
    await assert.rejects(
      ui.invoke(f.actor, {
        mountRef: lease.mountRef,
        action: "crewon.creative-projects.v1.listProjects",
        input: { query: { state: "all", cursor: null, limit: 1 } },
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        error.cause.message === "plugin_installation_timestamp_invalid",
    );
    assert.equal(
      await store.loadProject({ owner, projectId: f.reference.projectId }),
      null,
    );
  },
);
