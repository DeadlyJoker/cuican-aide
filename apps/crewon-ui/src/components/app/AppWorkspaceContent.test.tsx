import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AppWorkspaceContent } from "./AppWorkspaceContent";

describe("AppWorkspaceContent", () => {
  it("renders the chat workspace branch", () => {
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

    expect(markup).toContain("conversation-surface");
    expect(markup).toContain("Direct chat");
    expect(markup).toContain("Group chat");
    expect(markup).toContain("/repo/frontend");
    expect(markup).toMatchInlineSnapshot(`"<section class="conversation-surface" data-mode="code" data-state="start"><div class="conversation-mode-bar"><div class="conversation-mode-title"><span>Direct chat</span><strong>Let&#x27;s build</strong><em>No workspace selected</em></div><div class="mode-switch" aria-label="Switch conversation type"><button type="button" aria-pressed="true" data-active="true"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-message-square"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>Direct chat</button><button type="button" aria-pressed="false" data-active="false"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-users-round"><path d="M18 21a8 8 0 0 0-16 0"></path><circle cx="10" cy="8" r="5"></circle><path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"></path></svg>Group chat</button></div></div><main class="empty-state"><div class="empty-hero"><h1>Let&#x27;s build</h1><p>Connect to local app-server to browse project sessions, continue chats, and use the same workspace across macOS, Windows, and web.</p><div class="mode-switch" aria-label="Switch conversation type"><button type="button" aria-pressed="true" data-active="true"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-code-xml"><path d="m18 16 4-4-4-4"></path><path d="m6 8-4 4 4 4"></path><path d="m14.5 4-5 16"></path></svg>Direct chat</button><button type="button" aria-pressed="false" data-active="false"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sparkles"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"></path><path d="M20 3v4"></path><path d="M22 5h-4"></path><path d="M4 17v2"></path><path d="M5 18H3"></path></svg>Group chat</button></div><div class="mode-description">Talk with one agent for review, fixes, tests, and project commands.</div></div></main><form class="composer"><div class="composer-context"><span class="composer-workspace-chip" title="/repo/frontend"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-folder-open"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"></path></svg>/repo/frontend</span><div class="composer-context-actions"><span class="composer-status-pill" data-tone="connected" title="Connected to local app-server"><svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle"><circle cx="12" cy="12" r="10"></circle></svg>Connected to local app-server</span><button class="icon-button" type="button" aria-label="Session settings" title="Session settings"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-settings2"><path d="M20 7h-9"></path><path d="M14 17H5"></path><circle cx="17" cy="17" r="3"></circle><circle cx="7" cy="7" r="3"></circle></svg></button></div></div><div class="composer-input-row" data-state="idle"><button class="icon-button" type="button" aria-label="Attach context" title="Attach context"><svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-paperclip"><path d="M13.234 20.252 21 12.3"></path><path d="m16 6-8.414 8.586a2 2 0 0 0 0 2.828 2 2 0 0 0 2.828 0l8.414-8.586a4 4 0 0 0 0-5.656 4 4 0 0 0-5.656 0l-8.415 8.585a6 6 0 1 0 8.486 8.486"></path></svg></button><textarea rows="2" placeholder="Ask Crewon to inspect, edit, run, or explain..."></textarea><button class="send-button" type="submit" aria-label="Send" title="Send (⌘ Enter)" disabled=""><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up"><path d="m5 12 7-7 7 7"></path><path d="M12 19V5"></path></svg></button><div class="composer-tool-row"><span><span class="composer-state-dot" data-state="idle" aria-hidden="true"></span><span class="composer-state-text">Auto-pick tools and context</span></span><kbd class="composer-shortcut" title="Send (⌘ Enter)">⌘ Enter</kbd></div></div></form></section>"`);
  });
});
