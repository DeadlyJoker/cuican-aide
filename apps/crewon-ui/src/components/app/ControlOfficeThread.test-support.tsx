import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, vi } from "vitest";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ControlApiClient } from "@crewon/control-client";
import type {
  OfficeThreadResponse,
  OfficeThreadMutationResponse,
  ThreadCatalogResponse,
  ThreadView,
} from "@crewon/contracts";
import type { ControlOfficeDefinitionRecordReference } from "../../lib/office/officePanelFromRecord";
import { createControlCommandOfficeRoomAdapter } from "./ControlCommandOfficeRoomAdapter";
import { controlOfficeThreadTitle } from "./controlOfficeChatPresentation";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

export function catalogPage(
  threads: readonly Pick<Thread, "id" | "name">[] = [thread],
  olderCursor: string | null = null,
): ThreadCatalogResponse {
  return {
    schemaVersion: "crewon.thread-catalog.v0",
    data: threads.map(
      (item): ThreadView => ({
        threadId: item.id,
        title: item.name,
        status: "active",
        revision: 1,
        lastMessageSequence: 0,
        forkedFromThreadId: null,
        forkedThroughHistorySequence: null,
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z",
        archivedAt: null,
        deletedAt: null,
      }),
    ),
    scannedCount: threads.length || (olderCursor === null ? 0 : 100),
    olderCursor,
    newerCursor: null,
  };
}

export function officeAssociation(
  value: ThreadView | null = catalogPage().data[0]!,
): OfficeThreadResponse {
  return {
    officeId: record.definition.officeId,
    officeVersionId: record.definition.officeVersionId,
    thread: value,
  };
}
export function officeMutation(
  disposition: OfficeThreadMutationResponse["disposition"] = "existing",
  value: ThreadView = catalogPage().data[0]!,
): OfficeThreadMutationResponse {
  return { ...officeAssociation(value), thread: value, disposition };
}
export async function choose(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  );
  expect(button).toBeDefined();
  expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
}

export const record: ControlOfficeDefinitionRecordReference = {
  authority: "controlDefinition",
  filePath: "control:office:office-version-1",
  config: { title: "Read lifecycle", subtitle: "Control" },
  definition: {
    officeId: "office-1",
    officeVersionId: "office-version-1",
    revision: 1,
    members: [
      {
        agentVersionId: "agent-1",
        displayName: "Leader",
        memberId: "member-1",
      },
    ],
    executionTargets: [{ agentVersionId: "agent-1", targetId: "target-1" }],
  },
};
export const thread = {
  id: "thread-1",
  name: controlOfficeThreadTitle(record),
  status: { type: "idle" },
  turns: [],
  updatedAt: 1,
} as unknown as Thread;
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export async function send(container: HTMLElement) {
  const input = container.querySelector("textarea")!;
  expect(input.disabled).toBe(false);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, "Continue the task");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
export function fixture() {
  const runtime = {
    interruptTurn: vi.fn(),
    listThreads: vi.fn(async () => [thread]),
    readThread: vi.fn(
      async (_id: string, _options?: { signal?: AbortSignal }) => thread,
    ),
    renameThread: vi.fn(),
    startTurn: vi.fn(),
  };
  const client = {
    createOffice: vi.fn(),
    createThread: vi.fn(),
    getOfficeThread: vi.fn<ControlApiClient["getOfficeThread"]>(async () =>
      officeAssociation(),
    ),
    createOfficeThread: vi.fn<ControlApiClient["createOfficeThread"]>(
      async () => officeMutation("created"),
    ),
    bindOfficeThread: vi.fn<ControlApiClient["bindOfficeThread"]>(async () =>
      officeMutation("bound"),
    ),
    getThreadCatalog: vi.fn<ControlApiClient["getThreadCatalog"]>(async () =>
      catalogPage(),
    ),
    getActiveAgentVersionCatalog: vi.fn(),
    getExecutionIntentCapability: vi.fn(),
    getOffice: vi.fn(),
    listOffices: vi.fn(),
    getThreadGoal: vi.fn(
      async (_id: string, _options?: { signal?: AbortSignal }) => ({
        goal: null,
        eventSequence: 0,
      }),
    ),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let mounted = true;
  return {
    runtime,
    client,
    container,
    render: async (
      liveThreads: Thread[] = [],
      overrides: Partial<
        Parameters<typeof createControlCommandOfficeRoomAdapter>[0]
      > = {},
    ) => {
      const adapter = createControlCommandOfficeRoomAdapter({
        client: client as never,
        runtime,
        locale: "en",
        liveThreads,
        ...overrides,
      });
      await act(async () =>
        root.render(
          <StrictMode>{adapter.render(record, vi.fn(), vi.fn())}</StrictMode>,
        ),
      );
    },
    close: async () => {
      if (mounted) {
        mounted = false;
        await act(async () => root.unmount());
        container.remove();
      }
    },
  };
}
