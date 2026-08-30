import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Composer } from "./Composer";

describe("Composer", () => {
  it("renders context controls, composer input, and draft status", () => {
    const markup = renderToStaticMarkup(
      <Composer
        attachContextLabel="Attach context"
        autoModeLabel="Auto"
        busyStatusLabel="Working"
        connectionStatusLabel="Demo mode"
        connectionTone="demo"
        cwd="/repo/frontend"
        disabled={false}
        draftUnsavedLabel="Draft unsaved"
        focusSignal={0}
        isRunning={false}
        noWorkspaceSelectedLabel="No workspace"
        placeholder="Ask Crewon"
        retryConnectionLabel="Retry"
        sendLabel="Send"
        sendShortcutLabel="⌘↵"
        stopLabel="Stop"
        threadSettingsLabel="Thread settings"
        value="Refactor composer"
        onAttachContext={vi.fn()}
        onChange={vi.fn()}
        onRetryConnection={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onThreadSettings={vi.fn()}
      />,
    );

    expect(markup).toContain("/repo/frontend");
    expect(markup).toContain("Demo mode");
    expect(markup).toContain("Retry");
    expect(markup).toContain("Refactor composer");
    expect(markup).toContain("Draft unsaved");
    expect(markup).toMatchInlineSnapshot(`"<form class="composer"><div class="composer-context"><span class="composer-workspace-chip" title="/repo/frontend"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-folder-open"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"></path></svg>/repo/frontend</span><div class="composer-context-actions"><span class="composer-status-pill" data-tone="demo" title="Demo mode"><svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle"><circle cx="12" cy="12" r="10"></circle></svg>Demo mode</span><button class="composer-retry-button" type="button" title="Retry"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-refresh-cw"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M8 16H3v5"></path></svg>Retry</button><button class="icon-button" type="button" aria-label="Thread settings" title="Thread settings"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-settings2"><path d="M20 7h-9"></path><path d="M14 17H5"></path><circle cx="17" cy="17" r="3"></circle><circle cx="7" cy="7" r="3"></circle></svg></button></div></div><div class="composer-input-row" data-state="draft"><button class="icon-button" type="button" aria-label="Attach context" title="Attach context"><svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-paperclip"><path d="M13.234 20.252 21 12.3"></path><path d="m16 6-8.414 8.586a2 2 0 0 0 0 2.828 2 2 0 0 0 2.828 0l8.414-8.586a4 4 0 0 0 0-5.656 4 4 0 0 0-5.656 0l-8.415 8.585a6 6 0 1 0 8.486 8.486"></path></svg></button><textarea rows="2" placeholder="Ask Crewon">Refactor composer</textarea><button class="send-button" type="submit" aria-label="Send" title="Send (⌘↵)"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up"><path d="m5 12 7-7 7 7"></path><path d="M12 19V5"></path></svg></button><div class="composer-tool-row"><span class="composer-draft-status"><span class="composer-state-dot" data-state="draft" aria-hidden="true"></span><span class="composer-state-text">Draft unsaved</span></span><kbd class="composer-shortcut" title="Send (⌘↵)">⌘↵</kbd></div></div></form>"`);
  });
});
