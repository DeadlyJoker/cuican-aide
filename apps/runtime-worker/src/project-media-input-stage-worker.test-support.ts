import type {
  ExtensionTaskApplicationService,
  ProjectConversationStore,
  ProjectMediaInputStageStore,
} from "@crewon/application";
import type {
  ProjectConversationBinding,
  ProjectMediaInputStage,
} from "@crewon/domain";
export type MediaInputPublicAdmissionFixture = (
  input: Readonly<{
    fixture: Awaited<ReturnType<typeof mediaGenerationFixture>>;
    binding: ProjectConversationBinding;
    conversations: ProjectConversationStore;
    stages: ProjectMediaInputStageStore;
    threadService: ThreadApplicationService;
    stage: ProjectMediaInputStage;
    content: string;
  }>,
) => Promise<
  Awaited<
    ReturnType<
      ExtensionTaskApplicationService["createProjectMediaInputStageTurnFromHost"]
    >
  >
>;
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  ThreadApplicationService,
  type ProjectMediaInputStageCommitAuthority,
} from "@crewon/application";
import { createProjectConversationBinding } from "@crewon/domain";
import { parseMediaInputToolRequest } from "@crewon/contracts/project-media-input-tools";
import { mediaGenerationFixture } from "./project-media-generation.test-support.ts";
/** Actual project/references and stage admission. Leaves the new Run queued for the genuine Worker. */
export async function mediaInputStageWorkerFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  kind: "T10" | "D18" = "T10",
  options: Readonly<{
    admitStage?: MediaInputPublicAdmissionFixture;
    installedFixture?: NonNullable<
      Parameters<typeof mediaGenerationFixture>[2]
    >["installedFixture"];
    runtimeTargetFixture?: NonNullable<
      Parameters<typeof mediaGenerationFixture>[2]
    >["runtimeTargetFixture"];
  }> = {},
) {
  const f = await mediaGenerationFixture(t, backend, {
    unmetered: true,
    taskClockFixture: "current",
    taskKindFixture: "media-input",
    installedFixture: options.installedFixture,
    runtimeTargetFixture: options.runtimeTargetFixture,
  });
  // Keep unrelated historical source work out of this fixture's actual queue claim.
  for (let n = 0; n < 16; n++) {
    const old = await f.parent.claimNextWorkItem({
      ownerId: "named-media-input-source-history",
      leaseId: randomUUID(),
      leaseDurationMs: 300000,
    });
    if (!old) break;
  }
  const conversations = f.parent.projectConversationStore();
  await conversations.migrate();
  const stages = f.parent.projectMediaInputStageStore();
  await stages.migrate();
  const installation = f.target.installation;
  const controls = {
    live: true,
    policy: true,
    beforeCurrent: null as (() => void | Promise<void>) | null,
  };
  const active = () => {
    if (!controls.live) throw Error("named_media_input_tool_owner_retired");
  };
  const current = async () => {
    await controls.beforeCurrent?.();
    active();
    if (!controls.policy) throw Error("named_media_input_tool_denied");
  };
  const authority: ProjectMediaInputStageCommitAuthority = {
    version: "crewon.project-media-input-stage-commit.v1",
    actor: f.actor,
    installation,
    pin: f.pin,
    selection: f.target.selection,
    package: f.target.package,
    assertCurrent: current,
    assertTransactionCurrent: current,
    assertActive: active,
  };
  const threadService = new ThreadApplicationService({
    store: f.parent,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => new Date().toISOString() },
    ids: { nextId: () => randomUUID() },
    digester: f.digester,
    workspaceAdmission: {
      admit: async () => {
        active();
      },
    },
  });
  const thread = await threadService.prepareCreateThread(f.actor, {
    kind: "thread.create",
    title: "Media input preparation",
    workspaceId: "media-original-workspace",
    idempotencyKey: "media-input-conversation",
  });
  const event = thread.events[0];
  assert.ok(event?.type === "thread.created");
  const binding = createProjectConversationBinding(
    {
      bindingId: randomUUID(),
      owner: f.actor,
      profileId: installation.profileId,
      projectId: f.command.projectId,
      threadId: event.identity.threadId,
      workspaceId: "media-original-workspace",
      revision: 1,
      state: "active",
      currentInstallation: installation,
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
    },
    f.digester,
  );
  await conversations.commitBinding(
    {
      kind: "create",
      binding,
      expectedRevision: 0,
      receipt: {
        actor: f.actor,
        idempotencyKey: "media-input-conversation",
        requestDigest: f.digester.sha256("media-input-conversation"),
      },
      thread,
    },
    {
      authority: {
        ...authority,
        version: "crewon.project-conversation-commit.v1",
      },
    },
  );
  const brief = await f.parent.creativeProjectStore().loadBrief({
    owner: {
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      principalId: f.actor.principalId,
    },
    projectId: f.command.projectId,
    briefRevision: 1,
  });
  assert.ok(brief);
  const script =
    kind === "T10"
      ? null
      : {
          artifactId: f.script.artifact.artifactId,
          episodeId: "episode-1",
          contentRevision: 1,
        };
  const content = "Prepare confirmed media input for the selected workflow.";
  const stage: ProjectMediaInputStage = {
    kind: "media-input",
    workflowId:
      kind === "T10"
        ? "krea2-reference-four-view"
        : "flux2-three-reference-storyboard",
    configurationRevision: 2,
    briefRevision: 1,
    script,
  };
  const admitted = options.admitStage
    ? await options.admitStage({
        fixture: f,
        binding,
        conversations,
        stages,
        threadService,
        stage,
        content,
      })
    : await f.service.createProjectMediaInputStageTurnFromHost(
        f.actor,
        {
          pluginId: f.pin.pluginId,
          threadId: binding.threadId,
          expectedThreadRevision: 1,
          idempotencyKey: "media-input-agent-stage",
          intent: {
            kind: "generate",
            input: {
              prompt:
                "Prepare confirmed media input for the selected workflow.",
            },
          },
        },
        {
          binding,
          stage,
          sources: {
            brief: { briefRevision: 1, contentDigest: brief.contentDigest },
            script:
              script === null
                ? null
                : {
                    ...script,
                    contentDigest: f.script.contentRevision!.contentDigest,
                  },
          },
          content: "Prepare confirmed media input for the selected workflow.",
          authority,
          conversations,
          stages,
        },
      );
  const locator = {
    tenantId: f.actor.tenantId,
    spaceId: f.actor.spaceId,
    runId: admitted.result.binding.runId,
  };
  const admission = await f.ext.loadPluginTaskAdmission(locator);
  assert.ok(admission);
  const {
    target,
    idempotencyKey: _key,
    ...base
  } = kind === "T10" ? f.command : f.d18Command;
  const request = parseMediaInputToolRequest("saveInput", {
    ...base,
    configurationRevision: target.configurationRevision,
  });
  return {
    ...f,
    stage: admitted.mediaInputStageAdmission,
    admitted,
    admission,
    binding,
    conversations,
    stages,
    controls,
    active,
    current,
    locator,
    request,
  };
}
