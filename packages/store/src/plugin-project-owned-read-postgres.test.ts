import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
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

test(
  "postgres: original installed UI reads protected project and briefs through original queries, and refuses detached readers",
  {
    skip: !process.env.CREWON_TEST_POSTGRES_URL,
  },
  async (t) => {
    const f = await ownedConversationSqlFixture(t, "postgres");
    const store = f.parent.creativeProjectStore();
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
            query: { afterBriefRevision: number; limit: number };
          };
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
      ["getBrief", { projectId: f.reference.projectId, briefRevision: 1 }],
      [
        "listBriefs",
        {
          projectId: f.reference.projectId,
          query: { afterBriefRevision: 0, limit: 16 },
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
    assert.equal(
      await store.loadProject({ owner, projectId: f.reference.projectId }),
      null,
    );
  },
);
