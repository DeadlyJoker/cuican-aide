import { useEffect, useRef, useState } from "react";

import { ActivityBoard } from "../activity/ActivityBoard";
import type { Locale } from "../../lib/i18n";
import type {
  ArtifactItem,
  LibraryPanel,
  LibraryPanelAction,
  OfficeRunActivity,
} from "../../lib/domain/crewonDomain";
import { OfficeChatPanel } from "./OfficeChatPanel";
import { OfficeMembersPanel } from "./OfficeMembersPanel";
import { OfficeTasksPanel } from "./OfficeTasksPanel";
import { OfficeWorkspaceHeader } from "./OfficeWorkspaceHeader";

export function OfficeWorkspaceView({
  panel,
  locale,
  onBack,
  onPanelAction,
  onSendMessage,
  onDecision,
  onArtifact,
  onRunCancel,
  onRunRetry,
}: {
  panel: LibraryPanel;
  locale: Locale;
  onBack: () => void;
  onPanelAction: (action: LibraryPanelAction) => void;
  onSendMessage: (text: string) => void;
  onDecision: (id: string, decision: "approved" | "denied") => void;
  onArtifact: (artifact: ArtifactItem) => void;
  onRunCancel: (run: OfficeRunActivity) => void;
  onRunRetry: (run: OfficeRunActivity) => void;
}) {
  const workspace = panel.workspace;
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<"chat" | "activity">("chat");
  const streamRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const stream = streamRef.current;
    if (stream) {
      stream.scrollTop = stream.scrollHeight;
    }
  }, [workspace?.messages.length, tab]);

  if (!workspace) {
    return null;
  }

  function submit() {
    const text = draft.trim();
    if (!text) {
      return;
    }
    onSendMessage(text);
    setDraft("");
  }

  return (
    <main className="office-workspace" aria-label={panel.title}>
      <OfficeWorkspaceHeader
        panel={panel}
        workspace={workspace}
        locale={locale}
        onBack={onBack}
      />

      <div
        className="office-tabs"
        role="tablist"
        aria-label={locale === "zh" ? "办公室视图" : "Office views"}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "chat"}
          data-active={tab === "chat"}
          onClick={() => setTab("chat")}
        >
          {locale === "zh" ? "群聊" : "Group chat"}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "activity"}
          data-active={tab === "activity"}
          onClick={() => setTab("activity")}
        >
          {locale === "zh" ? "运行台" : "Activity"}
        </button>
      </div>

      {tab === "activity" ? (
        workspace.activity ? (
          <ActivityBoard
            data={workspace.activity}
            locale={locale}
            onDecision={onDecision}
            onArtifact={onArtifact}
            onRunCancel={onRunCancel}
            onRunRetry={onRunRetry}
          />
        ) : (
          <p className="activity-empty">
            {locale === "zh" ? "暂无运行记录。" : "No activity yet."}
          </p>
        )
      ) : (
        <div className="office-grid">
          <OfficeMembersPanel
            actions={panel.actions}
            workspace={workspace}
            locale={locale}
            onPanelAction={onPanelAction}
          />
          <OfficeChatPanel
            workspace={workspace}
            locale={locale}
            draft={draft}
            streamRef={streamRef}
            onDraftChange={setDraft}
            onSubmit={submit}
          />
          <OfficeTasksPanel workspace={workspace} locale={locale} />
        </div>
      )}
    </main>
  );
}
