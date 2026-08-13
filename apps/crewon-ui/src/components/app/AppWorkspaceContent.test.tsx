import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AppWorkspaceContent } from "./AppWorkspaceContent";

describe("AppWorkspaceContent", () => {
  it("renders the design-driven command workspace for new tasks", () => {
    const markup = renderToStaticMarkup(
      <AppWorkspaceContent
        activeTurnId={null}
        appView="chat"
        capabilityPanel={null}
        composerFocusSignal={0}
        composerValue=""
        connectionState="connected"
        cwd="/repo/frontend"
        disabled={false}
        isSending={false}
        libraryPanel={null}
        locale="en"
        platform="mac"
        selectedThread={null}
        selectedThreadId={null}
        slashCommands={[]}
        streamingTextByThread={{}}
        workMode="code"
        onApprovalDecision={vi.fn()}
        onArtifact={vi.fn()}
        onAttachContext={vi.fn()}
        onBackLibrary={vi.fn()}
        onChangeComposerValue={vi.fn()}
        onItemAction={vi.fn()}
        onLibraryPanelAction={vi.fn()}
        onModeChange={vi.fn()}
        onOfficeDelegationCancel={vi.fn()}
        onOfficeDelegationDispatch={vi.fn()}
        onOfficeDelegationRetry={vi.fn()}
        onOfficeVerificationCancel={vi.fn()}
        onOfficeVerificationRetry={vi.fn()}
        onOfficeRunCancel={vi.fn()}
        onOfficeRunRetry={vi.fn()}
        onPanelAction={vi.fn()}
        onPanelFieldChange={vi.fn()}
        onRetryConnection={vi.fn()}
        onSaveAgentConfig={vi.fn()}
        onSend={vi.fn()}
        onSlashCommandSelect={vi.fn()}
        onSendOfficeMessage={vi.fn()}
        onStop={vi.fn()}
        onThreadSettings={vi.fn()}
        onToggleAgentCapability={vi.fn()}
        onUpdateAgentConfig={vi.fn()}
      />,
    );

    expect(markup).toContain('data-od-id="desktop-command-screen"');
    expect(markup).toContain('class="desktop-window command-window"');
    expect(markup).toContain('data-od-id="desktop-sidebar"');
    expect(markup).toContain('data-od-id="scene-tabs"');
    expect(markup).toContain('data-od-id="quick-scenarios"');
    expect(markup).toContain('data-od-id="ai-composer"');
    expect(markup).toContain('data-od-id="context-search-panel"');
    expect(markup).toContain('data-od-id="slash-search-panel"');
    expect(markup).toContain("Put CrewON to work");
    expect(markup).toContain(">CrewON</strong>");
    expect(markup).toContain(">Office</button>");
    expect(markup).toContain(">Code</button>");
    expect(markup).toContain(">Design</button>");
    expect(markup).not.toContain("创建可编排的 Agent 小队");
    expect(markup).toContain("Tasks");
    expect(markup).toContain(
      "Conversations will appear here after you start a task.",
    );
    expect(markup).not.toContain("Workspaces");
    expect(markup).not.toContain("frontend");
    expect(markup).not.toContain("建议任务");
    expect(markup).not.toContain("agents0");
  });
});
