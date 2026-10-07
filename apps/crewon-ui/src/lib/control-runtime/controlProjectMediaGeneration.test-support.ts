import { vi } from "vitest";
import { ControlProjectMediaGeneration } from "./controlProjectMediaGeneration";
import {
  api,
  binding,
  at,
  digest,
  snapshot,
} from "./controlProjectMediaInputStage.test-support";
import type {
  GenerateProjectMediaRequest,
  GenerateProjectMediaResponse,
} from "@crewon/contracts/project-media-generations";
import type { ProjectMediaGenerationRecoveryHint } from "@crewon/contracts/project-media-generation-recovery";
export { binding, at, digest };
export const savedInput = {
  projectId: binding.projectId,
  mediaInputId: "input/中文",
  inputRevision: 1,
  item: { kind: "character-reference", assetId: "character" },
  briefRevision: 1,
  script: null,
  workflowId: "krea2-reference-four-view",
  configurationRevision: 1,
  prompt: "保留五官，生成正面、侧面与背面。",
  references: {
    character: {
      projectId: binding.projectId,
      assetId: "character",
      kind: "character",
      expectedAssetRevision: 4,
      contentRevision: 1,
      referenceRevision: 1,
    },
  },
  createdAt: at,
  contentDigest: digest,
} as const;
export function receipt(
  request: GenerateProjectMediaRequest,
): GenerateProjectMediaResponse {
  return {
    disposition: "committed",
    projectId: request.projectId,
    threadId: request.threadId,
    mediaInputId: request.mediaInputId,
    inputRevision: request.inputRevision,
    executionId: request.executionId,
    threadRevision: request.expectedThreadRevision + 1,
    runId: "actual-run",
  };
}
export function hint(
  request: GenerateProjectMediaRequest,
  phase: ProjectMediaGenerationRecoveryHint["phase"],
): ProjectMediaGenerationRecoveryHint {
  return {
    sourcePin: { ...binding.source, contributionId: "workbench" },
    request: {
      action: "crewon.project-media-generations.v1.generate",
      input: request,
    },
    phase,
    revision: phase === "prepared" ? 1 : 3,
    dispatchMayHaveOccurred: phase !== "prepared",
    dispatchAttemptCount: phase === "prepared" ? 0 : 1,
    retryable: phase === "prepared" || phase === "dispatched",
    receipt: phase === "accepted" ? receipt(request) : null,
    reasonCode:
      phase === "refused" ? "project_media_generation_not_admitted" : null,
  };
}
export function fixture() {
  const state = {
    intent: null as ProjectMediaGenerationRecoveryHint | null,
    binding: { ...binding },
    threadRevision: 3,
    input: { input: { ...savedInput }, latestInputRevision: 1 },
    next: null as string | null,
    configurationRevision: 1,
  };
  const posts: GenerateProjectMediaRequest[] = [],
    reads: string[] = [];
  let post: (
    request: GenerateProjectMediaRequest,
    init: RequestInit,
  ) => Promise<Response> = async (request) => {
    state.intent = hint(request, "accepted");
    return Response.json(receipt(request));
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "POST") {
      const request = {
        ...JSON.parse(init.body as string),
        projectId: binding.projectId,
        idempotencyKey: new Headers(init.headers).get("idempotency-key"),
      } as GenerateProjectMediaRequest;
      posts.push(request);
      return post(request, init);
    }
    reads.push(String(url));
    if (path.endsWith("/project-conversation"))
      return Response.json({ binding: state.binding });
    if (path.endsWith("/media-generation-recovery"))
      return Response.json({ intent: state.intent });
    if (path.endsWith("/media-input-options"))
      return Response.json({
        configuration: {
          revision: state.configurationRevision,
          workflows: [savedInput.workflowId],
        },
      });
    if (path.endsWith("/media-inputs"))
      return Response.json({
        inputs: [
          {
            projectId: binding.projectId,
            mediaInputId: savedInput.mediaInputId,
            latestInputRevision: 1,
            item: savedInput.item,
            workflowId: savedInput.workflowId,
            createdAt: at,
          },
        ],
        nextMediaInputId: state.next,
      });
    if (path.includes("/media-inputs/"))
      return Response.json({ state: state.input });
    if (path.endsWith("/threads/thread"))
      return Response.json({
        ...snapshot(state.threadRevision),
        eventSequence: state.threadRevision,
      });
    throw new Error(`unexpected fixture route ${path}`);
  });
  const client = api(fetch),
    presenter = { adoptExtensionTask: vi.fn(async () => {}) };
  let sequence = 0;
  const create = () =>
    new ControlProjectMediaGeneration({
      client,
      binding,
      briefRevision: 1,
      presenter,
      key: () => `key-${++sequence}`,
    });
  const controller = create();
  return {
    client,
    state,
    posts,
    reads,
    fetch,
    presenter,
    controller,
    create,
    setPost(value: typeof post) {
      post = value;
    },
    async ready() {
      await controller.refresh();
      await controller.select(savedInput.mediaInputId);
    },
  };
}
