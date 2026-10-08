import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  PROJECT_FOUNDATION_UI_METHOD_ACTIONS as A,
  PROJECT_FOUNDATION_UI_ACTIONS,
  projectFoundationUiCodec,
  type ProjectFoundationMutationResponse,
} from "@crewon/contracts/project-foundation";
import {
  PluginProjectFoundationActionOwner,
  isPluginProjectFoundationActionOwner,
} from "./plugin-project-foundation-action-owner.ts";
import {
  isProjectFoundationApplicationService,
  ProjectFoundationApplicationService,
} from "./project-foundation-application-service.ts";
import { capturePluginProjectFoundationInvocation } from "./plugin-project-foundation-invocation.ts";
import { capturePluginUiInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";
import { registerPluginUiActionInvocation } from "./plugin-ui-action-invocation-registration.ts";
import { projectFoundationActionFixture } from "./plugin-project-foundation-action.test-support.ts";
import { createCommand } from "./project-foundation-application-test-support.ts";
import {
  uiDeferred,
  uiTestActor,
  uiTestMountCommand,
} from "./plugin-ui.test-support.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import * as applicationApi from "./index.ts";
const mutation = (input: unknown) => input as ProjectFoundationMutationResponse;

test("the actual owner is public while invocation issuance remains private to the original UI host", () => {
  assert.equal(
    applicationApi.PluginProjectFoundationActionOwner,
    PluginProjectFoundationActionOwner,
  );
  for (const name of [
    "registerPluginProjectFoundationInvocation",
    "capturePluginProjectFoundationInvocation",
    "registerPluginUiActionInvocation",
    "registerPluginUiInvocation",
  ])
    assert.equal(Object.hasOwn(applicationApi, name), false, name);
});

test("novel creation uses only the upload locator and explicit adaptation parameters; canonical source remains a separate bounded read", async (t) => {
  const f = await projectFoundationActionFixture();
  t.after(() => f.owner.close());
  const input = {
    ...createCommand("novel"),
    sourceUpload: {
      uploadId: "upload-1",
      fileDigest: f.foundations.uploads.get("upload-1")!.fileDigest,
    },
  };
  const created = mutation(await f.invoke("createProject", input));
  assert.equal(created.foundation.origin, "novel");
  assert.equal(created.foundation.creativeStartMode, null);
  assert.equal(created.foundation.parameters.adaptation!.strategy, "core");
  assert.equal("chunks" in created.source!, false);
  assert.equal("content" in created.source!, false);
  assert.equal(
    f.foundations.sourceRequests[0]!.actor.actorId,
    uiTestActor.actorId,
  );
  assert.equal(f.foundations.sourceRequests[0]!.projectId, null);
  await assert.rejects(
    f.invoke("chooseCreativeStartMode", {
      projectId: created.project.projectId,
      expectedFoundationRevision: 1,
      creativeStartMode: "direct-script",
      idempotencyKey: "novel-cannot-direct",
    }),
  );
  const count = f.foundations.idCalls;
  await assert.rejects(
    f.invoke("createProject", {
      ...input,
      sourceUpload: {
        ...input.sourceUpload,
        bytes: Array.from({ length: 24 * 1024 }, () => 1),
      },
    }),
  );
  assert.equal(f.foundations.idCalls, count);
});

test("all12 Foundation UI actions use the actual mounted Service and original project identity with exact public DTOs", async (t) => {
  const f = await projectFoundationActionFixture();
  t.after(() => f.owner.close());
  assert.equal(isPluginProjectFoundationActionOwner(f.owner), true);
  assert.equal(
    isProjectFoundationApplicationService(f.foundationService),
    true,
  );
  for (const action of PROJECT_FOUNDATION_UI_ACTIONS)
    assert.equal(f.owner.supportsAction(action), true);
  let current = mutation(await f.invoke("createProject", createCommand()));
  const projectId = current.project.projectId;
  const saved = mutation(
    await f.invoke("saveProposal", {
      projectId,
      expectedFoundationRevision: 1,
      expectedProposalRevision: 0,
      kind: "creative-plan",
      text: "保留雨夜重逢，三集悬疑。",
      idempotencyKey: "plan-1",
    }),
  );
  assert.equal(saved.foundation.revision, 1);
  current = mutation(
    await f.invoke("confirmProposal", {
      projectId,
      expectedFoundationRevision: 1,
      proposalRevision: saved.proposal!.revision,
      proposalDigest: saved.proposal!.contentDigest,
      idempotencyKey: "confirm-1",
    }),
  );
  assert.deepEqual(current.foundation.confirmedProposal, {
    revision: 1,
    digest: saved.proposal!.contentDigest,
  });
  current = mutation(
    await f.invoke("chooseCreativeStartMode", {
      projectId,
      expectedFoundationRevision: current.foundation.revision,
      creativeStartMode: "direct-script",
      idempotencyKey: "direct-1",
    }),
  );
  current = mutation(
    await f.invoke("updateParameters", {
      projectId,
      expectedFoundationRevision: current.foundation.revision,
      parameters: { ...current.foundation.parameters, episodeCount: 4 },
      idempotencyKey: "params-1",
    }),
  );
  current = mutation(
    await f.invoke("appendSource", {
      projectId,
      expectedFoundationRevision: current.foundation.revision,
      sourceUpload: {
        uploadId: "upload-1",
        fileDigest: f.foundations.uploads.get("upload-1")!.fileDigest,
      },
      idempotencyKey: "source-1",
    }),
  );
  assert.equal(current.foundation.confirmedProposal, null);
  assert.equal(current.project.projectId, projectId);
  const source = current.source!;
  for (const [method, query] of [
    ["getFoundation", { projectId }],
    ["getSource", { projectId, sourceRevision: 1 }],
    ["getProposal", { projectId, proposalRevision: 1 }],
    ["listProposals", { projectId, afterProposalRevision: 0, limit: 3 }],
    [
      "readSourcePage",
      {
        projectId,
        sourceRevision: 1,
        sourceDigest: source.digest,
        startOffset: 0,
        limit: 4,
      },
    ],
    [
      "listSourceChapters",
      {
        projectId,
        sourceRevision: 1,
        sourceDigest: source.digest,
        afterStartOffset: null,
        limit: 16,
      },
    ],
  ] as const) {
    const output = await f.invoke(method, query);
    const request = projectFoundationUiCodec.parseRequest({
      action: A[method],
      input: query,
    });
    assert.doesNotThrow(() =>
      projectFoundationUiCodec.parseResponse(output, request),
    );
    const json = JSON.stringify(output);
    for (const key of [
      "ownerPrincipalId",
      "principalId",
      "tenantId",
      "spaceId",
      "actorId",
      "authorityEpoch",
      "provenance",
      "sourceUpload",
      "audit",
      "runId",
    ])
      assert.equal(json.includes(`"${key}"`), false, key);
  }
  assert.equal(f.store.projects.size, 1);
  assert.equal(
    [...f.store.projects.values()][0]!.ownerPrincipalId,
    uiTestActor.principalId,
  );
  assert.equal(f.store.receipts.size, 6);
  const page = await f.invoke("readSourcePage", {
    projectId,
    sourceRevision: 1,
    sourceDigest: source.digest,
    startOffset: 0,
    limit: 4,
  });
  assert.deepEqual(page, {
    page: {
      sourceRevision: 1,
      startOffset: 0,
      endOffset: 4,
      content: "雨😀夜\n",
      nextOffset: 4,
    },
  });
});
test("six writes get genuinely independent Foundation pins; reads, old creative actions and copied contexts cannot borrow them", async (t) => {
  const f = await projectFoundationActionFixture();
  t.after(() => f.owner.close());
  let captured:
    | ReturnType<typeof capturePluginProjectFoundationInvocation>
    | undefined;
  f.state.onContext = (context) => {
    const base = capturePluginUiInvocationCommitAuthority(context);
    const grant = capturePluginProjectFoundationInvocation(context);
    captured = grant;
    assert.equal(base.transaction, undefined);
    if (context.action === A.createProject) {
      assert.equal(
        grant.transaction!.version,
        "crewon.project-foundation-plugin-commit.v1",
      );
      assert.equal(grant.transaction!.pin.action, A.createProject);
      assert.equal(grant.transaction!.pin.actorId, uiTestActor.actorId);
      assert.equal(
        grant.transaction!.pin.selectionRevision,
        f.lease.selectionRevision,
      );
      assert.equal(grant.transaction!.pin.packageDigest, f.lease.packageDigest);
      assert.equal("run" in grant.transaction!, false);
    } else assert.equal(grant.transaction, undefined);
    assert.throws(
      () => capturePluginProjectFoundationInvocation({ ...context }),
      { code: "plugin_project_foundation_invocation_unavailable" },
    );
  };
  const created = mutation(await f.invoke("createProject", createCommand()));
  assert.throws(() => captured!.assertActive(), {
    code: "plugin_ui_invocation_unavailable",
  });
  await assert.rejects(captured!.transaction!.assertCurrent(), {
    code: "plugin_ui_invocation_unavailable",
  });
  await f.invoke("getFoundation", { projectId: created.project.projectId });
  await assert.rejects(f.owner.actions.invoke(f.state.context!), {
    code: "plugin_project_foundation_invocation_unavailable",
  });
  f.state.onContext = (context) => {
    assert.equal(
      capturePluginUiInvocationCommitAuthority(context).transaction!.version,
      "crewon.creative-project-plugin-commit.v1",
    );
    assert.throws(() => capturePluginProjectFoundationInvocation(context), {
      code: "plugin_project_foundation_invocation_unavailable",
    });
  };
  await assert.rejects(
    f.service.invoke(uiTestActor, {
      mountRef: f.lease.mountRef,
      action: "crewon.creative-projects.v1.createProject",
      input: {},
    }),
    { code: "plugin_project_foundation_invocation_unavailable" },
  );
  assert.equal(
    f.owner.supportsAction("crewon.project-foundation.v2.createProject"),
    false,
  );
});
test("forged contexts are rejected before getters; copied services and prototype impersonation never establish the actual brand", async (t) => {
  const f = await projectFoundationActionFixture();
  t.after(() => f.owner.close());
  let getters = 0;
  const forged = Object.defineProperty({}, "actor", {
    get() {
      getters++;
      return uiTestActor;
    },
  });
  await assert.rejects(
    f.owner.actions.invoke(forged as PluginUiActionContext),
    { code: "plugin_project_foundation_invocation_unavailable" },
  );
  assert.equal(getters, 0);
  for (const foundations of [
    {},
    { ...f.foundationService },
    Object.create(ProjectFoundationApplicationService.prototype),
  ]) {
    assert.equal(isProjectFoundationApplicationService(foundations), false);
    assert.throws(
      () =>
        new PluginProjectFoundationActionOwner({
          foundations: foundations as never,
          publications: f.publications,
          authorization: { authorize: async () => undefined },
        }),
      { code: "plugin_project_foundation_config_invalid" },
    );
  }
  assert.equal(isPluginProjectFoundationActionOwner({ ...f.owner }), false);
  assert.equal(f.store.projects.size, 0);
});
test("strict request rejection cleans the entire acquired invocation registration, before dispatch or project allocation", async (t) => {
  const f = await projectFoundationActionFixture();
  t.after(() => f.owner.close());
  await f.invoke("createProject", createCommand());
  const invalid = {
    ...f.state.context!,
    input: { ...createCommand(), tenantId: "forged" },
  };
  assert.throws(() =>
    registerPluginUiActionInvocation(invalid, {
      assertCurrent: async () => undefined,
      assertTransactionCurrent: async () => undefined,
      assertActive: () => undefined,
      usesRecovery: false,
    }),
  );
  assert.throws(() => capturePluginUiInvocationCommitAuthority(invalid), {
    code: "plugin_ui_invocation_unavailable",
  });
  assert.throws(() => capturePluginProjectFoundationInvocation(invalid), {
    code: "plugin_project_foundation_invocation_unavailable",
  });
  const allocations = f.foundations.idCalls;
  for (const input of [
    { ...createCommand(), owner: uiTestActor },
    {
      ...createCommand(),
      parameters: { ...createCommand().parameters, episodeMode: undefined },
    },
  ])
    await assert.rejects(f.invoke("createProject", input));
  assert.equal(f.foundations.idCalls, allocations);
});
test("actual immutable receipts replay without allocating another project and reject key reuse with changed business input", async (t) => {
  const f = await projectFoundationActionFixture();
  t.after(() => f.owner.close());
  const input = createCommand();
  const first = mutation(await f.invoke("createProject", input));
  const second = mutation(await f.invoke("createProject", input));
  assert.equal(second.disposition, "replayed");
  assert.deepEqual(first.foundation, second.foundation);
  assert.equal(f.foundations.idCalls, 1);
  assert.equal(f.store.projects.size, 1);
  await assert.rejects(
    f.invoke("createProject", { ...input, title: "不同项目" }),
    { code: "project_foundation_idempotency_conflict" },
  );
});
test("original mounted publication must match approved digest, contribution and an exact declared Foundation service v1", async (t) => {
  for (const change of [
    "missing",
    "wrong-version",
    "optional-ui-only",
    "unapproved-contribution",
    "unapproved",
  ] as const) {
    const f = await projectFoundationActionFixture();
    t.after(() => f.owner.close());
    await f.service.closeMount(uiTestActor, { mountRef: f.lease.mountRef });
    const d = f.ui.state.descriptor;
    f.ui.state.descriptor = parsePluginPackageDescriptor({
      ...d,
      requires:
        change === "missing"
          ? []
          : [
              {
                service: "crewon.project-foundation",
                apiVersion: change === "wrong-version" ? "2" : "1",
                optional: change === "optional-ui-only",
              },
            ],
    });
    const owner = ["unapproved", "unapproved-contribution"].includes(change)
      ? new PluginProjectFoundationActionOwner({
          foundations: f.foundationService,
          publications: [
            {
              ...f.publications[0]!,
              packageDigest:
                change === "unapproved"
                  ? `sha256:${"b".repeat(64)}`
                  : f.publications[0]!.packageDigest,
              contributionId:
                change === "unapproved-contribution"
                  ? "other-module"
                  : "workbench",
            },
          ],
          authorization: { authorize: async () => undefined },
        })
      : f.owner;
    t.after(() => owner.close());
    const lease = await f.service.openMount(uiTestActor, uiTestMountCommand);
    // Every call remains in the same genuine host registry; swap only the trusted action owner under test.
    if (["unapproved", "unapproved-contribution"].includes(change)) {
      // A second owner is tested during the genuine action invocation without issuing any caller-owned authority.
      f.state.beforeHost = async () => {
        await owner.actions.invoke(f.state.context!);
      };
    }
    await assert.rejects(
      f.service.invoke(uiTestActor, {
        mountRef: lease.mountRef,
        action: A.createProject,
        input: createCommand() as never,
      }),
      { code: "plugin_project_foundation_publication_unavailable" },
    );
    assert.equal(f.store.projects.size, 0);
  }
});
test("precommit host/project/mount withdrawal aborts writes while reads retain their post-fence", async (t) => {
  for (const withdrawal of ["host", "project", "mount"] as const) {
    const f = await projectFoundationActionFixture();
    t.after(() => f.owner.close());
    const entered = uiDeferred(),
      release = uiDeferred();
    f.store.before = async (method) => {
      if (method === "commitCreation") {
        entered.resolve();
        await release.promise;
      }
    };
    const pending = f.invoke("createProject", createCommand());
    await entered.promise;
    if (withdrawal === "host") f.state.hostAllowed = false;
    if (withdrawal === "project") f.foundations.allow = false;
    if (withdrawal === "mount")
      await f.service.closeMount(uiTestActor, { mountRef: f.lease.mountRef });
    release.resolve();
    await assert.rejects(pending);
    assert.equal(f.store.projects.size, 0);
  }
  const f = await projectFoundationActionFixture();
  t.after(() => f.owner.close());
  const created = mutation(await f.invoke("createProject", createCommand()));
  f.store.before = async (method) => {
    if (method === "loadFoundation") f.ui.state.allowed.delete("invoke");
  };
  await assert.rejects(
    f.invoke("getFoundation", { projectId: created.project.projectId }),
    { code: "plugin_ui_authorization_denied" },
  );
});
test("confirmed metadata remains deliverable after COMMIT policy/owner withdrawal; opaque receipts are context-bound and single-use", async () => {
  const f = await projectFoundationActionFixture();
  f.store.afterCommit = () => {
    f.ui.state.allowed.delete("invoke");
    f.state.hostAllowed = false;
    void f.owner.close();
  };
  const saved = mutation(await f.invoke("createProject", createCommand()));
  assert.equal(saved.disposition, "committed");
  assert.equal(f.store.projects.size, 1);
  await f.owner.close();
  assert.equal(f.owner.committedMetadata.isOutcome(saved), false);
  assert.throws(
    () =>
      f.owner.committedMetadata.verify(f.state.context!, f.state.raw as never),
    { code: "plugin_ui_committed_metadata_invalid" },
  );
  const g = await projectFoundationActionFixture();
  g.state.afterAction = (context, raw) => {
    assert.equal(g.owner.committedMetadata.isOutcome(raw), true);
    assert.throws(
      () => g.owner.committedMetadata.verify({ ...context }, raw as never),
      { code: "plugin_ui_committed_metadata_invalid" },
    );
  };
  await assert.rejects(g.invoke("createProject", createCommand()), {
    code: "plugin_ui_output_invalid",
  });
  assert.equal(g.store.projects.size, 1);
  await g.owner.close();
});
test("owner close withdraws pending actions synchronously and joins completion before releasing the shared Store", async () => {
  const f = await projectFoundationActionFixture();
  const entered = uiDeferred(),
    release = uiDeferred();
  f.store.before = async (method) => {
    if (method === "commitCreation") {
      entered.resolve();
      await release.promise;
    }
  };
  const pending = f.invoke("createProject", createCommand());
  await entered.promise;
  let joined = false;
  const closing = f.owner.close().then(() => {
    joined = true;
  });
  await Promise.resolve();
  assert.equal(joined, false);
  release.resolve();
  await assert.rejects(pending);
  await closing;
  assert.equal(joined, true);
  assert.equal(f.store.projects.size, 0);
});

test("the 64-call owner limit is enforced before authorization or commit and close joins every admitted call", async () => {
  const f = await projectFoundationActionFixture();
  const entered = uiDeferred(),
    release = uiDeferred();
  let count = 0;
  f.state.beforeHost = async () => {
    if (++count === 64) entered.resolve();
    await release.promise;
  };
  const pending = Array.from({ length: 64 }, (_, index) =>
    f.invoke("createProject", createCommand("creative", `pending-${index}`)),
  );
  await entered.promise;
  await assert.rejects(
    f.invoke("createProject", createCommand("creative", "overflow")),
    { code: "plugin_project_foundation_inflight_limit" },
  );
  assert.equal(count, 64);
  assert.equal(f.foundations.idCalls, 0);
  let joined = false;
  const closing = f.owner.close().then(() => {
    joined = true;
  });
  await Promise.resolve();
  assert.equal(joined, false);
  release.resolve();
  const outcomes = await Promise.allSettled(pending);
  assert.ok(outcomes.every((value) => value.status === "rejected"));
  await closing;
  assert.equal(joined, true);
  assert.equal(f.store.projects.size, 0);
});

test("checked replay outcomes use the same trusted metadata path without a post-confirmation authorization check", async () => {
  const f = await projectFoundationActionFixture();
  const input = createCommand();
  const first = mutation(await f.invoke("createProject", input));
  f.state.afterAction = (context, raw) => {
    assert.equal(context.action, A.createProject);
    assert.equal(f.owner.committedMetadata.isOutcome(raw), true);
    f.ui.state.allowed.delete("invoke");
    f.state.hostAllowed = false;
    void f.owner.close();
  };
  const replay = mutation(await f.invoke("createProject", input));
  assert.equal(replay.disposition, "replayed");
  assert.deepEqual(replay.project, first.project);
  assert.equal(f.store.projects.size, 1);
  assert.equal(f.foundations.idCalls, 1);
  await f.owner.close();
});

test("optional external liveness checks reject withdrawal at the final synchronous Store fence", async (t) => {
  let current = true;
  const f = await projectFoundationActionFixture({
    assertActive: (context, request) => {
      assert.equal(context.action, request.action);
      if (!current) throw new Error("fixture_private_configuration_changed");
    },
  });
  t.after(() => f.owner.close());
  f.store.beforePublish = () => {
    current = false;
  };
  await assert.rejects(f.invoke("createProject", createCommand()), {
    code: "plugin_project_foundation_action_denied",
  });
  assert.equal(f.store.projects.size, 0);
  assert.equal(f.store.receipts.size, 0);
});

test("the optional external check never revokes an already committed mutation or replay", async (t) => {
  for (const replay of [false, true]) {
    let current = true;
    const f = await projectFoundationActionFixture({
      assertActive: () => {
        if (!current) throw new Error("fixture_private_configuration_changed");
      },
    });
    t.after(() => f.owner.close());
    const command = createCommand();
    if (replay) await f.invoke("createProject", command);
    f.state.afterAction = () => {
      current = false;
    };
    const result = mutation(await f.invoke("createProject", command));
    assert.equal(result.disposition, replay ? "replayed" : "committed");
    assert.equal(f.store.projects.size, 1);
    assert.equal(f.store.receipts.size, 1);
  }
});

test("external liveness configuration rejects accessors without invoking them and rejects asynchronous proof", async (t) => {
  const f = await projectFoundationActionFixture();
  t.after(() => f.owner.close());
  let accessed = false;
  assert.throws(
    () =>
      new PluginProjectFoundationActionOwner({
        foundations: f.foundationService,
        publications: f.publications,
        authorization: Object.defineProperty(
          { authorize: async () => undefined },
          "assertActive",
          {
            get() {
              accessed = true;
              return () => undefined;
            },
          },
        ),
      }),
    { code: "plugin_project_foundation_config_invalid" },
  );
  assert.equal(accessed, false);
  const g = await projectFoundationActionFixture({
    assertActive: (() => Promise.resolve()) as never,
  });
  t.after(() => g.owner.close());
  await assert.rejects(g.invoke("createProject", createCommand()), {
    code: "plugin_project_foundation_authorization_invalid",
  });
  assert.equal(g.foundations.idCalls, 0);
  assert.equal(g.store.receipts.size, 0);
  const h = await projectFoundationActionFixture({
    assertActive: (async () => {
      throw new Error("fixture_async_liveness_is_not_authority");
    }) as never,
  });
  t.after(() => h.owner.close());
  await assert.rejects(h.invoke("createProject", createCommand()), {
    code: "plugin_project_foundation_authorization_invalid",
  });
  assert.equal(h.store.receipts.size, 0);
});
