import { useEffect, useRef, useState } from "react";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type {
  CreateExtensionTaskRequest,
  ExtensionCatalogEntry,
  ExtensionTaskMutationResponse,
  ExtensionTaskView,
} from "@crewon/contracts";
import type {
  GetExtensionActivationResponse,
  GetExtensionConfigurationResponse,
} from "@crewon/contracts";

import {
  ControlApiClientError,
  type ControlApiClient,
} from "@crewon/control-client";
import type { ControlThreadRuntime } from "../../lib/control-runtime/controlThreadRuntime";
import type { Locale } from "../../lib/i18n";
import type {
  BusinessExtensionPanelProps,
  ExtensionAgentOption,
} from "./BusinessExtensionPanel";
import {
  extensionErrorCopy,
  extensionMutationUncertain,
} from "./businessExtensionPresentation";

type ExtensionActivation = NonNullable<
  GetExtensionActivationResponse["activation"]
>;
type ExtensionConfiguration = NonNullable<
  GetExtensionConfigurationResponse["configuration"]
>;

export type BusinessExtensionClient = Pick<
  ControlApiClient,
  | "getExtensionConfiguration"
  | "getExtensionActivation"
  | "saveExtensionConfiguration"
  | "setExtensionActivation"
  | "getExtensionRuntime"
  | "getExtensionTask"
  | "getActiveAgentVersionCatalog"
  | "getThread"
  | "createThread"
  | "createExtensionTask"
>;
export type BusinessExtensionThreadRuntime = Pick<
  ControlThreadRuntime,
  "adoptExtensionTask"
>;
type PendingTask = {
  intent: CreateExtensionTaskRequest["intent"];
  createThreadKey: string;
  taskKey: string;
  request: CreateExtensionTaskRequest | null;
  receipt: ExtensionTaskMutationResponse | null;
};

export function useBusinessExtension(input: {
  client: BusinessExtensionClient;
  runtime: BusinessExtensionThreadRuntime;
  entry: ExtensionCatalogEntry;
  locale: Locale;
  open: boolean;
  thread: Thread | null;
  onCommitted(threadId: string): void;
}): Omit<BusinessExtensionPanelProps, "title" | "description" | "onOpenRun"> {
  const [configuration, setConfiguration] =
    useState<ExtensionConfiguration | null>(null);
  const [activation, setActivation] = useState<ExtensionActivation | null>(
    null,
  );
  const [baseUrl, setBaseUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agents, setAgents] = useState<ExtensionAgentOption[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [readyReason, setReadyReason] = useState<string>();
  const [phase, setPhase] =
    useState<BusinessExtensionPanelProps["phase"]>("loading");
  const [busy, setBusy] = useState<BusinessExtensionPanelProps["busy"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<ExtensionTaskView[]>([]);
  const [pendingTask, setPendingTask] =
    useState<BusinessExtensionPanelProps["pendingTask"]>(null);
  const [refresh, setRefresh] = useState(0);
  const epoch = useRef(0);
  const requests = useRef(new Set<AbortController>());
  const mutating = useRef(false);
  const pending = useRef<PendingTask | null>(null);
  const configurationRef = useRef(configuration);
  configurationRef.current = configuration;
  const scope = `${input.entry.pluginId}:${input.entry.pluginVersion}:${input.thread?.id ?? "new"}`;
  const key = (name: string) => `extension.${name}:${crypto.randomUUID()}`;
  const runIds =
    input.thread?.turns
      .slice(-8)
      .map((turn) => turn.id)
      .reverse() ?? [];
  const runKey =
    input.thread?.turns
      .slice(-8)
      .map((turn) => `${turn.id}:${turn.status}`)
      .join(":") ?? "";

  useEffect(() => {
    epoch.current += 1;
    setConfiguration(null);
    setActivation(null);
    setBaseUrl("");
    setPrompt("");
    setSelected(null);
    setReady(false);
    setTasks([]);
    setError(null);
    setBusy(null);
    setPhase("loading");
    setPendingTask(null);
    pending.current = null;
    mutating.current = false;
    return () => {
      epoch.current += 1;
      for (const request of requests.current) request.abort();
      requests.current.clear();
    };
  }, [input.client, scope]);

  useEffect(() => {
    epoch.current += 1;
    mutating.current = false;
    setBusy(null);
    setPendingTask(
      pending.current === null
        ? null
        : pending.current.receipt === null
          ? "retrySubmission"
          : "resumeAccepted",
    );
    return () => {
      epoch.current += 1;
      for (const request of requests.current) request.abort();
      requests.current.clear();
    };
  }, [input.open]);

  useEffect(() => {
    if (!input.open) return;
    const controller = new AbortController(),
      current = epoch.current;
    requests.current.add(controller);
    setPhase("loading");
    void Promise.all([
      input.client.getExtensionConfiguration(
        input.entry.pluginId,
        {},
        { signal: controller.signal },
      ),
      input.client.getExtensionActivation(input.entry.pluginId, {
        signal: controller.signal,
      }),
      input.client.getActiveAgentVersionCatalog({ signal: controller.signal }),
    ])
      .then(([saved, enabled, catalog]) => {
        if (controller.signal.aborted || epoch.current !== current) return;
        const priorConfiguration = configurationRef.current;
        setBaseUrl((draft) =>
          priorConfiguration === null ||
          draft === priorConfiguration.parameters.baseUrl
            ? typeof saved.configuration?.parameters.baseUrl === "string"
              ? saved.configuration.parameters.baseUrl
              : ""
            : draft,
        );
        setConfiguration(saved.configuration);
        setActivation(enabled.activation);
        setAgents(
          catalog.data.map((agent) => ({
            agentVersionId: agent.agentVersionId,
            label: `${agent.agentVersionId} · ${agent.model.modelId}`,
            available: true,
          })),
        );
        setSelected((prior) =>
          prior !== null &&
          catalog.data.some((agent) => agent.agentVersionId === prior)
            ? prior
            : enabled.activation?.target?.agentVersionId &&
                catalog.data.some(
                  (agent) =>
                    agent.agentVersionId ===
                    enabled.activation?.target?.agentVersionId,
                )
              ? enabled.activation.target.agentVersionId
              : null,
        );
        setPhase("ready");
        setError(null);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && epoch.current === current) {
          setPhase("unavailable");
          setError(extensionErrorCopy(failure, input.locale));
        }
      })
      .finally(() => requests.current.delete(controller));
    return () => controller.abort();
  }, [
    input.client,
    input.open,
    input.entry.pluginId,
    scope,
    refresh,
    input.locale,
  ]);

  useEffect(() => {
    setReady(false);
    if (!input.open || configuration === null || selected === null) {
      setReadyReason(undefined);
      return;
    }
    const controller = new AbortController(),
      current = epoch.current;
    requests.current.add(controller);
    setReadyReason(
      input.locale === "zh"
        ? "正在核对所选 Agent 的执行能力…"
        : "Checking the selected Agent's execution availability…",
    );
    void input.client
      .getExtensionRuntime(
        input.entry.pluginId,
        {
          agentVersionId: selected,
          configurationRevision: configuration.revision,
        },
        { signal: controller.signal },
      )
      .then((result) => {
        if (controller.signal.aborted || epoch.current !== current) return;
        const available = result.readiness.outcome === "ready";
        setReady(available);
        setReadyReason(
          available
            ? undefined
            : input.locale === "zh"
              ? "所选 Agent 暂不能执行此配置，请完成部署后刷新。"
              : "The selected Agent cannot execute this configuration. Complete deployment and refresh.",
        );
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && epoch.current === current)
          setReadyReason(extensionErrorCopy(failure, input.locale));
      })
      .finally(() => requests.current.delete(controller));
    return () => controller.abort();
  }, [
    input.client,
    input.open,
    input.entry.pluginId,
    configuration?.revision,
    selected,
    refresh,
    input.locale,
  ]);

  useEffect(() => {
    if (!input.open) return;
    if (runIds.length === 0) {
      setTasks([]);
      return;
    }
    const controller = new AbortController(),
      current = epoch.current;
    requests.current.add(controller);
    void Promise.all(
      runIds.map(async (runId) => {
        try {
          return (
            await input.client.getExtensionTask(input.entry.pluginId, runId, {
              signal: controller.signal,
            })
          ).task;
        } catch (failure) {
          if (
            failure instanceof ControlApiClientError &&
            failure.status === 404 &&
            failure.code === "extension_task_not_found"
          )
            return null;
          throw failure;
        }
      }),
    )
      .then((result) => {
        if (!controller.signal.aborted && epoch.current === current)
          setTasks(
            result.filter((task): task is ExtensionTaskView => task !== null),
          );
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && epoch.current === current) {
          setTasks([]);
          setError(extensionErrorCopy(failure, input.locale));
        }
      })
      .finally(() => requests.current.delete(controller));
    return () => controller.abort();
  }, [
    input.client,
    input.open,
    input.entry.pluginId,
    scope,
    runKey,
    refresh,
    input.locale,
  ]);

  async function action(
    kind: NonNullable<BusinessExtensionPanelProps["busy"]>,
    execute: (signal: AbortSignal, assertCurrent: () => void) => Promise<void>,
  ) {
    if (!input.open || mutating.current || phase !== "ready") return;
    const current = epoch.current,
      controller = new AbortController();
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (epoch.current !== current)
        throw new Error("extension_ui_scope_changed");
    };
    requests.current.add(controller);
    mutating.current = true;
    setBusy(kind);
    setError(null);
    try {
      await execute(controller.signal, assertCurrent);
    } catch (failure) {
      if (!controller.signal.aborted && epoch.current === current)
        setError(extensionErrorCopy(failure, input.locale));
    } finally {
      requests.current.delete(controller);
      if (epoch.current === current) {
        mutating.current = false;
        setBusy(null);
      }
    }
  }
  const createTask = (intent: CreateExtensionTaskRequest["intent"]) =>
    action(
      (pending.current?.intent.kind ?? intent.kind) === "query"
        ? "querying"
        : "generating",
      async (signal, assertCurrent) => {
        const taskEpoch = epoch.current;
        const retry: PendingTask = pending.current ?? {
          intent:
            intent.kind === "generate"
              ? { kind: "generate", input: { prompt } }
              : { ...intent },
          createThreadKey: key("thread"),
          taskKey: key("task"),
          request: null,
          receipt: null,
        };
        pending.current = retry;
        try {
          if (retry.request === null) {
            const threadId =
              input.thread?.id ??
              (
                await input.client.createThread(
                  { title: input.entry.title },
                  retry.createThreadKey,
                  { signal },
                )
              ).thread.threadId;
            assertCurrent();
            const actual = (await input.client.getThread(threadId, { signal }))
              .thread;
            assertCurrent();
            retry.request = {
              threadId,
              expectedThreadRevision: actual.revision,
              intent: retry.intent,
            };
          }
          const receipt =
            retry.receipt ??
            (await input.client.createExtensionTask(
              input.entry.pluginId,
              retry.request,
              retry.taskKey,
              { signal },
            ));
          assertCurrent();
          retry.receipt = receipt;
          setPendingTask("resumeAccepted");
          const task = (
            await input.client.getExtensionTask(
              input.entry.pluginId,
              receipt.runId,
              { signal },
            )
          ).task;
          assertCurrent();
          if (task.threadId !== receipt.threadId)
            throw new Error("extension_task_thread_mismatch");
          setTasks((prior) =>
            [task, ...prior.filter((item) => item.runId !== task.runId)].slice(
              0,
              8,
            ),
          );
          await input.runtime.adoptExtensionTask(receipt, { signal });
          assertCurrent();
          pending.current = null;
          setPendingTask(null);
          setPrompt("");
          input.onCommitted(receipt.threadId);
        } catch (failure) {
          if (!signal.aborted && epoch.current === taskEpoch) {
            if (retry.receipt !== null) setPendingTask("resumeAccepted");
            else if (extensionMutationUncertain(failure))
              setPendingTask("retrySubmission");
            else {
              pending.current = null;
              setPendingTask(null);
            }
          }
          throw failure;
        }
      },
    );
  return {
    locale: input.locale,
    phase,
    configuration,
    activation,
    baseUrl,
    onBaseUrlChange: setBaseUrl,
    agentVersions: agents,
    selectedAgentVersionId: selected,
    selectedAgentReady: ready,
    readyReason,
    onAgentVersionChange: setSelected,
    prompt,
    onPromptChange: setPrompt,
    tasks,
    busy,
    error,
    pendingTask,
    onRefresh: () => setRefresh((value) => value + 1),
    onSave: () => {
      if (pending.current) return;
      void action("saving", async (signal, assertCurrent) => {
        const result = await input.client.saveExtensionConfiguration(
          input.entry.pluginId,
          {
            pluginVersion: input.entry.pluginVersion,
            expectedRevision: configuration?.revision ?? 0,
            parameters: { baseUrl },
            credentialBindings: [],
          },
          key("configuration"),
          { signal },
        );
        assertCurrent();
        setReady(false);
        setConfiguration(result.configuration);
      });
    },
    onEnable: (agentVersionId) => {
      if (
        pending.current ||
        !ready ||
        !configuration ||
        selected !== agentVersionId ||
        baseUrl !== configuration.parameters.baseUrl
      )
        return;
      void action("enabling", async (signal, assertCurrent) => {
        const result = await input.client.setExtensionActivation(
          input.entry.pluginId,
          {
            state: "enabled",
            expectedRevision: activation?.revision ?? 0,
            configurationRevision: configuration.revision,
            agentVersionId,
          },
          key("activation"),
          { signal },
        );
        assertCurrent();
        setActivation(result.activation);
      });
    },
    onDisable: () => {
      if (pending.current || !configuration) return;
      void action("disabling", async (signal, assertCurrent) => {
        const result = await input.client.setExtensionActivation(
          input.entry.pluginId,
          {
            state: "disabled",
            expectedRevision: activation?.revision ?? 0,
            configurationRevision: configuration.revision,
            agentVersionId: null,
          },
          key("activation"),
          { signal },
        );
        assertCurrent();
        setActivation(result.activation);
      });
    },
    onGenerate: () => {
      if (
        !pending.current &&
        (!prompt.trim() ||
          prompt.length > 2_000 ||
          activation?.state !== "enabled" ||
          !configuration ||
          activation.configurationRevision !== configuration.revision ||
          activation.configurationDigest !== configuration.contentDigest ||
          !activation.target ||
          !ready ||
          baseUrl !== configuration.parameters.baseUrl ||
          selected !== activation.target.agentVersionId)
      )
        return;
      void createTask({ kind: "generate", input: { prompt } });
    },
    onQuery: (source) => {
      if (
        pending.current ||
        activation?.state === "revoked" ||
        !tasks.some((task) =>
          task.operations.some(
            (operation) =>
              operation.sourceRunId === source.sourceRunId &&
              operation.operationId === source.operationId,
          ),
        )
      )
        return;
      void createTask({ kind: "query", ...source });
    },
  };
}
