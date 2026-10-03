import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreativeProjectApplicationService,
  capturePluginUiInvocationCommitAuthority,
  type CreativeProjectStore,
} from "@crewon/application";
import { SqliteRunStore } from "@crewon/store";
import { committedUiFixture } from "../../../packages/application/src/plugin-ui-committed-task.test-support.ts";
import { taskActor } from "../../../packages/application/src/extension-plugin-task.test-support.ts";

test(
  "policy denial during actual asset loading cannot append a concept revision",
  { timeout: 10000 },
  async () => {
    await withFixture(async (f) => {
      const created = await f.app.createProject(taskActor, command());
      const concept = await f.app.createConcept(taskActor, {
        projectId: created.project.projectId,
        name: "概念图",
        briefRevision: 1,
        prompt: "窗边的一封信",
        expectedProjectRevision: created.project.revision,
        idempotencyKey: randomUUID(),
      });
      const barrier = gate();
      const read = f.projects.loadConceptAsset.bind(f.projects);
      f.projects.loadConceptAsset = async (input) => {
        const saved = await read(input);
        barrier.enter();
        await barrier.released;
        return saved;
      };
      const pending = f.invoke(async () => {
        await f.app.appendConceptRevision(
          taskActor,
          {
            projectId: concept.project.projectId,
            assetId: concept.asset.assetId,
            briefRevision: 1,
            prompt: "雨夜的一封信",
            expectedProjectRevision: concept.project.revision,
            expectedAssetMetadataRevision: concept.asset.revision,
            idempotencyKey: randomUUID(),
          },
          {
            authority: capturePluginUiInvocationCommitAuthority(
              f.ui.state.context!,
            ),
          },
        );
      });
      try {
        await Promise.race([
          barrier.entered,
          pending.then(() => {
            throw new Error("guarded action ended before barrier");
          }),
        ]);
        f.ui.state.allow = false;
      } finally {
        barrier.release();
      }
      await assert.rejects(pending, { code: "plugin_ui_authorization_denied" });
      f.projects.loadConceptAsset = read;
      const revisions = await f.app.listConceptRevisions(taskActor, {
        projectId: concept.project.projectId,
        assetId: concept.asset.assetId,
        afterAssetRevision: 0,
        limit: 50,
      });
      assert.equal(revisions.length, 1);
      assert.equal(revisions[0]?.assetRevision, 1);
      assert.equal(
        (
          await f.app.getProject(taskActor, {
            projectId: concept.project.projectId,
          })
        ).revision,
        concept.project.revision,
      );
    });
  },
);

// The real Application invocation and SQLite are exercised; UI installation, HTTP and paid execution are not claimed.
async function withFixture(
  run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  const f = await fixture();
  try {
    await run(f);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true });
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crewon-project-invocation-"));
  const store = new SqliteRunStore(join(root, "project.sqlite"));
  try {
    const projects = store.creativeProjectStore();
    await projects.migrate();
    const ui = committedUiFixture();
    ui.state.mode = "json";
    const app = new CreativeProjectApplicationService({
      store: projects,
      authorization: { authorize: async () => ({ outcome: "allow" }) },
      clock: { now: () => new Date().toISOString() },
      ids: { nextId: () => randomUUID() },
      digester: {
        sha256: (text) =>
          "sha256:" + createHash("sha256").update(text).digest("hex"),
      },
    });
    const lease = await ui.service.openMount(taskActor, ui.openCommand);
    const invoke = (afterAction: () => Promise<void>) => {
      ui.state.afterAction = afterAction;
      return ui.service.invoke(taskActor, {
        mountRef: lease.mountRef,
        action: "read",
        input: null,
      });
    };
    return { root, store, projects, ui, app, lease, invoke };
  } catch (error) {
    store.close();
    await rm(root, { recursive: true });
    throw error;
  }
}
function gate() {
  let release!: () => void;
  let enter!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  return { release, enter, released, entered };
}
const command = () => ({
  title: "真实保存",
  briefText: "一封未寄出的信。",
  idempotencyKey: randomUUID(),
});
async function projects(f: Awaited<ReturnType<typeof fixture>>) {
  return f.app.listProjects(taskActor, {
    state: "all",
    after: null,
    limit: 50,
  });
}

test(
  "real closeMount during receipt lookup prevents SQLite project, brief and receipt creation",
  { timeout: 10000 },
  async () => {
    await withFixture(async (f) => {
      const barrier = gate();
      const read = f.projects.loadMutationReceipt.bind(f.projects);
      f.projects.loadMutationReceipt = async (input) => {
        const saved = await read(input);
        barrier.enter();
        await barrier.released;
        return saved;
      };
      const input = command();
      const pending = f.invoke(async () => {
        const authority = capturePluginUiInvocationCommitAuthority(
          f.ui.state.context!,
        );
        await f.app.createProject(taskActor, input, { authority });
      });
      try {
        await Promise.race([
          barrier.entered,
          pending.then(() => {
            throw new Error("guarded action ended before barrier");
          }),
        ]);
        await f.ui.service.closeMount(taskActor, {
          mountRef: f.lease.mountRef,
        });
      } finally {
        barrier.release();
      }
      await assert.rejects(pending, { code: "plugin_ui_mount_unavailable" });
      assert.equal((await projects(f)).projects.length, 0);
      assert.equal(f.ui.tasks.state.commits.length, 0);
      // No denied write receipt can be replayed: the same business command creates once later.
      const retried = await f.app.createProject(taskActor, input);
      assert.equal(retried.disposition, "committed");
    });
  },
);

test(
  "closeMount during actual project loading cannot append a new immutable brief",
  { timeout: 10000 },
  async () => {
    await withFixture(async (f) => {
      const created = await f.app.createProject(taskActor, command());
      const barrier = gate();
      const read = f.projects.loadProject.bind(f.projects);
      f.projects.loadProject = async (input) => {
        const saved = await read(input);
        barrier.enter();
        await barrier.released;
        return saved;
      };
      const pending = f.invoke(async () => {
        await f.app.appendBrief(
          taskActor,
          {
            projectId: created.project.projectId,
            text: "新的需求。",
            expectedProjectRevision: created.project.revision,
            idempotencyKey: randomUUID(),
          },
          {
            authority: capturePluginUiInvocationCommitAuthority(
              f.ui.state.context!,
            ),
          },
        );
      });
      try {
        await Promise.race([
          barrier.entered,
          pending.then(() => {
            throw new Error("guarded action ended before barrier");
          }),
        ]);
        await f.ui.service.closeMount(taskActor, {
          mountRef: f.lease.mountRef,
        });
      } finally {
        barrier.release();
      }
      await assert.rejects(pending, { code: "plugin_ui_mount_unavailable" });
      f.projects.loadProject = read;
      const current = await f.app.getProject(taskActor, {
        projectId: created.project.projectId,
      });
      assert.equal(current.revision, created.project.revision);
      const history = await f.app.listBriefs(taskActor, {
        projectId: current.projectId,
        afterBriefRevision: 0,
        limit: 50,
      });
      assert.equal(history.length, 1);
    });
  },
);

test(
  "mount expiry during an immutable brief read cannot create a concept asset",
  { timeout: 10000 },
  async () => {
    await withFixture(async (f) => {
      const created = await f.app.createProject(taskActor, command());
      const barrier = gate();
      const read = f.projects.loadBrief.bind(f.projects);
      f.projects.loadBrief = async (input) => {
        const saved = await read(input);
        barrier.enter();
        await barrier.released;
        return saved;
      };
      const pending = f.invoke(async () => {
        await f.app.createConcept(
          taskActor,
          {
            projectId: created.project.projectId,
            name: "概念画面",
            briefRevision: 1,
            prompt: "雨夜窗边的信",
            expectedProjectRevision: created.project.revision,
            idempotencyKey: randomUUID(),
          },
          {
            authority: capturePluginUiInvocationCommitAuthority(
              f.ui.state.context!,
            ),
          },
        );
      });
      try {
        await Promise.race([
          barrier.entered,
          pending.then(() => {
            throw new Error("guarded action ended before barrier");
          }),
        ]);
        f.ui.state.now = f.lease.expiresAt;
      } finally {
        barrier.release();
      }
      await assert.rejects(pending, { code: "plugin_ui_mount_expired" });
      f.projects.loadBrief = read;
      assert.equal(
        (
          await f.app.listConceptAssets(taskActor, {
            projectId: created.project.projectId,
            afterAssetId: null,
            limit: 50,
          })
        ).length,
        0,
      );
    });
  },
);

test(
  "all six mutations pass the same borrowed authority separately from their persisted recipes",
  { timeout: 10000 },
  async () => {
    await withFixture(async (f) => {
      const commits: string[] = [];
      for (const name of [
        "commitProjectCreation",
        "commitProjectMetadata",
        "commitProjectBrief",
        "commitConceptRevision",
      ] as const) {
        const original = f.projects[name].bind(f.projects) as (
          input: unknown,
          options?: { authority?: unknown },
        ) => Promise<unknown>;
        (f.projects as unknown as Record<string, unknown>)[name] = async (
          input: unknown,
          options?: { authority?: unknown },
        ) => {
          assert.ok(options?.authority);
          assert.equal("authority" in (input as object), false);
          assert.equal("options" in (input as object), false);
          commits.push(name);
          return original(input, options);
        };
      }
      await f.invoke(async () => {
        const authority = capturePluginUiInvocationCommitAuthority(
          f.ui.state.context!,
        );
        const options = { authority };
        let { project } = await f.app.createProject(
          taskActor,
          command(),
          options,
        );
        ({ project } = await f.app.renameProject(
          taskActor,
          {
            projectId: project.projectId,
            title: "原始版本保留",
            expectedProjectRevision: project.revision,
            idempotencyKey: randomUUID(),
          },
          options,
        ));
        ({ project } = await f.app.appendBrief(
          taskActor,
          {
            projectId: project.projectId,
            text: "修改后的需求",
            expectedProjectRevision: project.revision,
            idempotencyKey: randomUUID(),
          },
          options,
        ));
        const first = await f.app.createConcept(
          taskActor,
          {
            projectId: project.projectId,
            name: "概念图",
            briefRevision: project.latestBriefRevision,
            prompt: "晴天窗台",
            expectedProjectRevision: project.revision,
            idempotencyKey: randomUUID(),
          },
          options,
        );
        const next = await f.app.appendConceptRevision(
          taskActor,
          {
            projectId: project.projectId,
            assetId: first.asset.assetId,
            briefRevision: first.assetRevision.briefRevision,
            prompt: "雨夜窗台",
            expectedProjectRevision: first.project.revision,
            expectedAssetMetadataRevision: first.asset.revision,
            idempotencyKey: randomUUID(),
          },
          options,
        );
        await f.app.setProjectState(
          taskActor,
          {
            projectId: project.projectId,
            state: "archived",
            expectedProjectRevision: next.project.revision,
            idempotencyKey: randomUUID(),
          },
          options,
        );
      });
      assert.equal(commits.length, 6);
      assert.equal((await projects(f)).projects[0]?.state, "archived");
    });
  },
);

test(
  "a confirmed SQLite commit remains a real receipt when its mount closes before delivery",
  { timeout: 10000 },
  async () => {
    await withFixture(async (f) => {
      const input = command();
      const original = f.projects.commitProjectCreation.bind(f.projects);
      f.projects.commitProjectCreation = async (
        ...args: Parameters<CreativeProjectStore["commitProjectCreation"]>
      ) => {
        const result = await original(...args);
        await f.ui.service.closeMount(taskActor, {
          mountRef: f.lease.mountRef,
        });
        return result;
      };
      let committed = false;
      const pending = f.invoke(async () => {
        const result = await f.app.createProject(taskActor, input, {
          authority: capturePluginUiInvocationCommitAuthority(
            f.ui.state.context!,
          ),
        });
        assert.equal(result.disposition, "committed");
        committed = true;
      });
      // The existing plain-JSON UI fence remains unchanged; committed-metadata delivery is a subsequent Host-bridge step.
      await assert.rejects(pending, { code: "plugin_ui_mount_unavailable" });
      assert.equal(committed, true);
      assert.equal((await projects(f)).projects.length, 1);
      const replay = await f.app.createProject(taskActor, input);
      assert.equal(replay.disposition, "replayed");
    });
  },
);
