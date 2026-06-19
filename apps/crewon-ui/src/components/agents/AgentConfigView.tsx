import { useState } from "react";

import type { Locale } from "../../lib/i18n";
import type { AgentConfig, LibraryPanel } from "../../lib/domain/crewonDomain";
import { AgentBasicsCard } from "./AgentBasicsCard";
import { AgentCapabilityCard } from "./AgentCapabilityCard";
import { AgentConfigActions } from "./AgentConfigActions";
import { AgentConfigHeader } from "./AgentConfigHeader";
import { AgentHistoryCard } from "./AgentHistoryCard";
import { AgentPromptCard } from "./AgentPromptCard";

type AgentConfigViewProps = {
  panel: LibraryPanel;
  locale: Locale;
  onBack: () => void;
  onUpdate: (patch: Partial<AgentConfig>) => void;
  onToggleCapability: (group: "mcp" | "skills", id: string) => void;
  onSave: () => void | Promise<void>;
  onOpenThread: (threadId: string) => void;
};

export function AgentConfigView({
  panel,
  locale,
  onBack,
  onUpdate,
  onToggleCapability,
  onSave,
  onOpenThread,
}: AgentConfigViewProps) {
  const config = panel.agentConfig;
  const [saved, setSaved] = useState(false);

  if (!config) {
    return null;
  }

  function updateConfig(patch: Partial<AgentConfig>) {
    setSaved(false);
    onUpdate(patch);
  }

  function toggleCapability(group: "mcp" | "skills", id: string) {
    setSaved(false);
    onToggleCapability(group, id);
  }

  return (
    <main className="agent-config" aria-label={config.name}>
      <AgentConfigHeader config={config} locale={locale} onBack={onBack} />
      {panel.error ? <p className="library-error">{panel.error}</p> : null}
      {panel.body ? <pre className="agent-config-note">{panel.body}</pre> : null}

      <div className="agent-config-body">
        <AgentBasicsCard
          config={config}
          locale={locale}
          onUpdate={updateConfig}
        />
        <AgentPromptCard
          config={config}
          locale={locale}
          onUpdate={updateConfig}
        />
        <AgentCapabilityCard
          group="mcp"
          options={config.mcp}
          locale={locale}
          onToggleCapability={toggleCapability}
        />
        <AgentCapabilityCard
          group="skills"
          options={config.skills}
          locale={locale}
          onToggleCapability={toggleCapability}
        />
        <AgentHistoryCard config={config} panel={panel} locale={locale} />
        <AgentConfigActions
          config={config}
          locale={locale}
          saved={saved}
          onOpenThread={onOpenThread}
          onSave={() => {
            onSave();
            setSaved(true);
          }}
        />
      </div>
    </main>
  );
}
