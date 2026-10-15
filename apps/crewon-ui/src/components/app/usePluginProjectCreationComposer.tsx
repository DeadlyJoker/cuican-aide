import { useRef, useState } from "react";
import type { CommandWorkspaceHostModule } from "./CommandWorkspaceHostModule";
import { TranscriptMessage } from "../TranscriptMessage";
import type { Locale } from "../../lib/i18n";

/** Presentation over the shared Send action and shared message renderer; no plugin chat runtime. */
export function usePluginProjectCreationComposer(
  module: CommandWorkspaceHostModule | undefined,
  locale: Locale,
  ownerKey: object | null,
) {
  type Pending = {
    ownerKey: object | null;
    pluginId: string;
    content: string;
    modelId?: string;
    phase: "working" | "failed" | "completed";
  };
  const [pending, setPending] = useState<ReadonlyMap<string, Pending>>(
    new Map(),
  );
  const flights = useRef(new Map<string, object | null>());
  const currentOwner = useRef(ownerKey);
  currentOwner.current = ownerKey;
  const eligible = Boolean(
    module?.pluginId &&
      module.startProjectConversation &&
      !module.conversationProjectId,
  );
  const key = module?.pluginId ?? "";
  const record = pending.get(key);
  const visible = !eligible
    ? null
    : record?.ownerKey === ownerKey
      ? record.phase === "completed"
        ? null
        : record
      : module?.projectCreationDraft
        ? {
            ...module.projectCreationDraft,
            ownerKey,
            pluginId: key,
            phase: "failed" as const,
          }
        : null;
  const submit = (content: string, modelId?: string) => {
    if (
      !module?.startProjectConversation ||
      flights.current.get(module.pluginId!) === ownerKey
    )
      return;
    const launch = module.startProjectConversation;
    const pluginId = module.pluginId!;
    const execute = async () => {
      if (
        currentOwner.current !== ownerKey ||
        flights.current.get(pluginId) === ownerKey
      )
        return;
      flights.current.set(pluginId, ownerKey);
      const update = (phase: Pending["phase"]) => {
        if (currentOwner.current !== ownerKey) return;
        setPending((before) => {
          const next = new Map(before);
          next.set(pluginId, {
            ownerKey,
            pluginId,
            content,
            ...(modelId ? { modelId } : {}),
            phase,
          });
          return next;
        });
      };
      update("working");
      try {
        await launch({ content, ...(modelId ? { modelId } : {}) });
        update("completed");
      } catch {
        update("failed");
      } finally {
        if (flights.current.get(pluginId) === ownerKey)
          flights.current.delete(pluginId);
      }
    };
    void execute();
  };
  return {
    eligible,
    busy: visible !== null,
    submit,
    room: visible ? (
      <section
        className="command-thread-room"
        aria-label={locale === "zh" ? "新项目对话" : "New project conversation"}
      >
        <div className="transcript" role="log">
          <TranscriptMessage
            locale={locale}
            item={{
              type: "userMessage",
              id: "project-creation-user",
              clientId: null,
              content: [
                { type: "text", text: visible.content, text_elements: [] },
              ],
            }}
            itemLabels={{
              commandLabel: "",
              crewonLabel: "CrewON",
              filesLabel: "",
              planLabel: "",
              reasoningLabel: "",
              youLabel: locale === "zh" ? "你" : "You",
            }}
          />
          {visible.phase === "working" ? (
            <p role="status">
              {locale === "zh"
                ? "正在建立项目并连接 Agent…"
                : "Creating your project and connecting Agent…"}
            </p>
          ) : (
            <div role="alert">
              <p>
                {locale === "zh"
                  ? "暂未完成，重试会继续原请求，不会重复创建项目。"
                  : "Not completed. Retry continues the original request without creating another project."}
              </p>
              <button
                type="button"
                className="button"
                onClick={() => submit(visible.content, visible.modelId)}
              >
                {locale === "zh" ? "重试" : "Retry"}
              </button>
            </div>
          )}
        </div>
      </section>
    ) : null,
  };
}
