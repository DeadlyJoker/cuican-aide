import { act, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ControlApiClient } from "@crewon/control-client";
import type {
  GetExtensionActivationResponse,
  GetExtensionConfigurationResponse,
} from "@crewon/contracts";
import { ControlThreadRuntime } from "../../lib/control-runtime/controlThreadRuntime";
import { BusinessExtensionController } from "./BusinessExtensionController";
import { Transcript } from "../Transcript";

export type BusinessExtensionFlowHost = {
  client: ControlApiClient;
  endpoint: string;
  requests: { method: string; path: string; cursor: string | null }[];
  disconnections: { path: string; cursor: number }[];
  modelRequests: Record<string, unknown>[];
  comfyRequests: string[];
  prepareSavedPlugin(
    configuration: NonNullable<
      GetExtensionConfigurationResponse["configuration"]
    >,
  ): Promise<string>;
  runBinding(runId: string): {
    target: NonNullable<GetExtensionActivationResponse["activation"]>["target"];
    configurationRevision: number;
  };
  logTail(): string;
  recordEvidence(input: {
    configuration: NonNullable<
      GetExtensionConfigurationResponse["configuration"]
    >;
    target: NonNullable<GetExtensionActivationResponse["activation"]>["target"];
    threadId: string;
    generationRunId: string;
    queryRunId: string;
  }): void;
  close(): Promise<void>;
};

/** Keep the Node fixture outside the renderer's static dependency graph. */
export async function startBusinessExtensionFlowHost(): Promise<BusinessExtensionFlowHost> {
  const modulePath = "../../../electron/BusinessExtensionFlow.test-support.ts";
  const fixture = await import(/* @vite-ignore */ modulePath);
  return fixture.startBusinessExtensionFlowHost();
}

export function mountBusinessExtensionFlow(
  client: ControlApiClient,
  initial: Thread | null = null,
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const observed = {
    thread: initial,
    runtime: null as ControlThreadRuntime | null,
    opened: [] as string[],
    settled: [] as string[],
    errors: [] as unknown[],
    deltas: [] as string[],
  };
  function Harness() {
    const [thread, setThread] = useState(initial);
    const [streaming, setStreaming] = useState("");
    observed.thread = thread;
    const runtime = useMemo(
      () =>
        new ControlThreadRuntime(
          { client },
          {
            onThread: setThread,
            onTextDelta: (_id, delta) => {
              observed.deltas.push(delta);
              setStreaming((prior) => prior + delta);
            },
            onTextReset: () => setStreaming(""),
            onToolItem: (_threadId, runId, item) =>
              setThread((prior) =>
                prior === null
                  ? null
                  : {
                      ...prior,
                      turns: prior.turns.map((turn) =>
                        turn.id !== runId
                          ? turn
                          : {
                              ...turn,
                              items: [
                                ...turn.items.filter(
                                  (existing) => existing.id !== item.id,
                                ),
                                item,
                              ],
                            },
                      ),
                    },
              ),
            onTurnSettled: (_threadId, turn) =>
              setThread((prior) =>
                prior === null
                  ? null
                  : {
                      ...prior,
                      turns: prior.turns.map((existing) =>
                        existing.id === turn.id ? turn : existing,
                      ),
                    },
              ),
            onRunSettled: (_threadId, runId) => {
              observed.settled.push(runId);
              setStreaming("");
            },
            onStreamError: (_threadId, _runId, error) =>
              observed.errors.push(error),
            onThreadStreamError: (_threadId, error) =>
              observed.errors.push(error),
          },
        ),
      [],
    );
    observed.runtime = runtime;
    useEffect(() => () => runtime.close(), [runtime]);
    useEffect(
      () => runtime.setThreadEventStreamFocus(thread?.id ?? null),
      [runtime, thread?.id],
    );
    return (
      <>
        <BusinessExtensionController
          client={client}
          runtime={runtime}
          thread={thread}
          locale="en"
          onOpenThread={(id) => observed.opened.push(id)}
        />
        <button
          type="button"
          disabled={!thread}
          onClick={() => {
            if (thread)
              void runtime
                .resumeThread(thread.id)
                .then(setThread)
                .catch((error) => observed.errors.push(error));
          }}
        >
          Resume conversation
        </button>
        <Transcript
          thread={thread}
          streamingText={streaming}
          locale="en"
          mode="code"
          onModeChange={() => {}}
          onStop={() => {}}
          commandLabel="Command"
          crewonLabel="CrewON"
          emptyTitle="New task"
          emptyDescription="Create a task"
          filesLabel="Files"
          loadingLabel="Loading"
          modeCodeLabel="Code"
          modeCodeDescription="Code"
          modeOfficeLabel="Office"
          modeOfficeDescription="Office"
          modeTitleLabel="Mode"
          planLabel="Plan"
          reasoningLabel="Reasoning"
          stopLabel="Stop"
          youLabel="You"
        />
      </>
    );
  }
  return {
    container,
    observed,
    async render() {
      await act(async () => root.render(<Harness />));
    },
    async close() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

export async function flowUntil(check: () => boolean, description: string) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
  throw new Error(`business_extension_ui_timeout: ${description}`);
}
export async function clickFlowButton(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!button || button.disabled)
    throw new Error(`business_extension_ui_button_unavailable: ${label}`);
  await act(async () => button.click());
}
export async function editFlowField(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  await act(async () => {
    const prototype =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      field,
      value,
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
export async function selectFlowAgent(
  container: HTMLElement,
  agentVersionId: string,
) {
  await act(async () => {
    const select = container.querySelector("select")!;
    select.value = agentVersionId;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
