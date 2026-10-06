import { ControlApiClient } from "@crewon/control-client";
import type { GetThreadResponse } from "@crewon/contracts";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { PublicProjectConversationBinding } from "@crewon/contracts/project-conversations";
import type { GetProjectTextArtifactResponse } from "@crewon/contracts";
import type { ProjectMediaInputStageComposerSelection } from "./controlProjectMediaInputStageTurn";
export const at = "2026-10-06T00:00:00.000Z";
export const digest = `sha256:${"a".repeat(64)}`;
export const binding: PublicProjectConversationBinding = {
  bindingId: "binding",
  projectId: "project/中文",
  threadId: "thread",
  workspaceId: "workspace",
  revision: 1,
  state: "active",
  source: {
    pluginId: "crewon.short-drama",
    publisherId: "example.publisher",
    version: "23.0.0",
    packageDigest: digest,
    selectionRevision: 2,
  },
  createdAt: at,
  updatedAt: at,
};
export const selection: ProjectMediaInputStageComposerSelection = {
  binding,
  stage: {
    kind: "media-input",
    workflowId: "krea2-reference-four-view",
    configurationRevision: 1,
    briefRevision: 1,
    script: null,
  },
};
export const input = {
  threadId: "thread",
  content: " 角色想法\n保留原话 ",
  expectedThreadRevision: 3,
  selection,
};
export const acknowledgement = {
  disposition: "committed",
  threadId: "thread",
  threadRevision: 4,
  runId: "actual-run",
  runRevision: 1,
  bindingRevision: 1,
  stageAdmissionDigest: digest,
};
export function api(fetch: typeof globalThis.fetch): ControlApiClient {
  return new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: "fixture-token",
    csrfToken: "fixture-csrf",
    fetch,
  });
}
export function deferred<T>() {
  let resolve!: (v: T) => void;
  return {
    promise: new Promise<T>((r) => {
      resolve = r;
    }),
    resolve,
  };
}
export function snapshot(revision = 3): GetThreadResponse {
  return {
    thread: {
      threadId: "thread",
      workspaceId: "workspace",
      title: null,
      status: "active",
      revision,
      lastMessageSequence: 0,
      forkedFromThreadId: null,
      forkedThroughHistorySequence: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      deletedAt: null,
    },
    eventSequence: 0,
  };
}
export function presentedThread(): Thread {
  return {
    id: "thread",
    sessionId: "thread",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    modelProvider: "fixture",
    createdAt: 0,
    updatedAt: 0,
    status: { type: "idle" },
    path: null,
    cwd: "/fixture",
    clientVersion: "fixture",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [
      {
        id: "actual-run",
        items: [],
        itemsView: "full",
        status: "inProgress",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      },
    ],
  };
}
export function scriptView(
  episodeId = "episode-1",
  briefRevision = 1,
): GetProjectTextArtifactResponse {
  return {
    view: {
      artifact: {
        projectId: binding.projectId,
        artifactId: `script-${episodeId}`,
        kind: "script",
        episodeId,
        revision: 2,
        latestContentRevision: 1,
        selectedContentRevision: 1,
        locked: false,
        createdAt: at,
        updatedAt: at,
      },
      selectedRevision: {
        projectId: binding.projectId,
        artifactId: `script-${episodeId}`,
        kind: "script",
        episodeId,
        contentRevision: 1,
        brief: { briefRevision, contentDigest: digest },
        outline: null,
        content: {
          title: "雨夜",
          scenes: [
            {
              sceneId: "scene",
              location: "街道",
              timeOfDay: "雨夜",
              action: "角色收到一封信。",
              dialogue: [{ speaker: "角色", text: "你回来了。" }],
            },
          ],
        },
        createdAt: at,
        contentDigest: digest,
      },
      dependencyState: "current",
      staleReasons: [],
    },
  };
}
