import { describe, expect, it } from "vitest";

import type { ArtifactItem, OfficeWorkspace } from "../domain/crewonDomain";
import {
  officeArtifactDirectoryPanel,
  officeArtifactDisconnectedPanel,
  officeArtifactDraftBody,
  officeArtifactDraftPanel,
  officeArtifactDraftPanelBody,
  officeArtifactErrorPanel,
  officeArtifactLoadedPanel,
  officeArtifactLoadedPanelBody,
  officeArtifactLocatingPanel,
  officeArtifactSavedPanel,
  officeArtifactSystemMessage,
  officeArtifactTurnPrompt,
  officeSavedArtifact,
  officeWorkspaceWithArtifactMessage,
} from "./officeArtifactPanel";

function artifactItem(overrides: Partial<ArtifactItem> = {}): ArtifactItem {
  return {
    title: "Client brief",
    kind: "markdown",
    glyph: "◈",
    accent: "violet",
    meta: "client-demo",
    ...overrides,
  };
}

function workspace(overrides: Partial<OfficeWorkspace> = {}): OfficeWorkspace {
  return {
    goal: "Ship cleaner frontend",
    members: [],
    messages: [],
    tasks: [],
    backendStatus: "connected",
    ...overrides,
  };
}

describe("office artifact panel helpers", () => {
  it("builds artifact status panels", () => {
    const artifact = artifactItem();

    expect(officeArtifactDisconnectedPanel(artifact, "en")).toEqual({
      title: "Client brief",
      subtitle: "Office artifact",
      body: "Connect app-server to search and read this artifact from the current workspace.",
    });
    expect(officeArtifactLocatingPanel(artifact, "zh")).toEqual({
      title: "Client brief",
      subtitle: "正在定位产物",
      body: "正在工作区中搜索：Client brief",
    });
    expect(
      officeArtifactErrorPanel({
        artifact,
        error: "unknown",
        locale: "en",
      }),
    ).toEqual({
      title: "Client brief",
      subtitle: "Office artifact",
      error: "Unable to locate artifact",
    });
  });

  it("builds office artifact draft content and updates", () => {
    const artifact = artifactItem();
    const artifactPath = "/repo/.crewon/offices/artifacts/client-brief.md";
    const body = officeArtifactDraftBody({
      artifact,
      createdAtIso: "2026-06-17T07:00:00.000Z",
      locale: "en",
      officeGoal: "Ship cleaner frontend",
    });
    const message = officeArtifactSystemMessage({
      artifact,
      artifactPath,
      locale: "en",
    });
    const baseWorkspace = workspace({
      messages: [
        {
          author: "System",
          glyph: "⌗",
          accent: "slate",
          time: "now",
          text: "Existing",
        },
      ],
    });

    expect(body).toBe(
      [
        "# Client brief",
        "- Kind: markdown",
        "- Source: Crewon office",
        "- Created: 2026-06-17T07:00:00.000Z",
        "- Office goal: Ship cleaner frontend",
        "client-demo",
        "This captures an office collaboration deliverable for reuse by agents, automations, or the knowledge library.",
      ].join("\n"),
    );
    expect(officeSavedArtifact(artifact, artifactPath, "zh")).toEqual({
      ...artifact,
      meta: `client-demo · 已保存 ${artifactPath}`,
    });
    expect(message).toEqual({
      author: "System",
      glyph: "⌗",
      accent: "violet",
      time: "now",
      kind: "system",
      text: `Created office artifact: Client brief, saved to ${artifactPath}`,
    });
    expect(officeWorkspaceWithArtifactMessage(baseWorkspace, message)).toEqual({
      ...baseWorkspace,
      messages: [...baseWorkspace.messages, message],
    });
    expect(
      officeArtifactSavedPanel(
        {
          kind: "office",
          title: "Frontend Office",
          subtitle: "Refactor desk",
          items: [],
          workspace: baseWorkspace,
        },
        {
          workspace: officeWorkspaceWithArtifactMessage(baseWorkspace, message),
          threadId: "thread-1",
        },
      ),
    ).toMatchObject({
      workspace: {
        threadId: "thread-1",
        backendStatus: "connected",
        messages: [...baseWorkspace.messages, message],
      },
    });
    expect(
      officeArtifactTurnPrompt({
        artifact,
        body,
        locale: "en",
        officeTitle: "Frontend Office",
      }),
    ).toBe(
      [
        'Office "Frontend Office" created artifact: Client brief',
        "Backend record: submitted to office/artifact/upsert",
        "",
        body,
      ].join("\n"),
    );
    expect(
      officeArtifactDraftPanelBody({
        artifactBody: body,
        locale: "en",
        metadataText: "Type: file",
      }),
    ).toBe(
      [
        "No existing artifact was found, so a workspace artifact draft was created.",
        "Type: file",
        body,
      ].join("\n\n"),
    );
  });

  it("builds artifact capability panels with search controls", () => {
    const artifact = artifactItem();
    const artifactPath = "/repo/.crewon/offices/artifacts/client-brief.md";

    expect(
      officeArtifactDraftPanel({
        artifact,
        artifactBody: "body",
        artifactDir: "/repo/.crewon/offices/artifacts",
        artifactPath,
        locale: "en",
        metadataText: "Type: file",
      }),
    ).toMatchObject({
      title: "Client brief",
      subtitle: artifactPath,
      body: [
        "No existing artifact was found, so a workspace artifact draft was created.",
        "Type: file",
        "body",
      ].join("\n\n"),
      actions: [
        { id: "copy-current-path", label: "Copy to .copy" },
        { id: "create-context-note", label: "New context note" },
        { id: "search-files", label: "Search", tone: "primary" },
        { id: "watch-current-path", label: "Watch" },
        { id: "unwatch-current-path", label: "Unwatch" },
        { id: "clear-file-search", label: "Clear" },
      ],
      fields: [
        {
          id: "file-search",
          label: "Search files",
          placeholder: "File name or path",
          value: "Client brief",
        },
        {
          id: "file-search-root",
          label: "Search root",
          value: "/repo/.crewon/offices/artifacts",
        },
      ],
    });

    expect(
      officeArtifactDirectoryPanel({
        artifact,
        artifactPath: "/repo/artifacts",
        items: [{ label: "> docs", path: "/repo/artifacts/docs", kind: "directory" }],
        locale: "en",
      }),
    ).toMatchObject({
      title: "Client brief",
      subtitle: "/repo/artifacts",
      body: "Directory artifact located. Reading entries...",
      items: [{ label: "> docs", path: "/repo/artifacts/docs", kind: "directory" }],
    });
  });

  it("builds loaded office artifact panel body and panel", () => {
    const artifact = artifactItem();
    expect(
      officeArtifactLoadedPanelBody({
        fileText: "",
        locale: "en",
        metadataText: "Type: file",
      }),
    ).toBe(
      [
        "Office artifact loaded from the backend workspace.",
        "Type: file",
        "Empty file",
      ].join("\n\n"),
    );

    expect(
      officeArtifactLoadedPanelBody({
        fileText: "a".repeat(12001),
        locale: "zh",
        metadataText: "",
      }),
    ).toBe(
      [
        "办公室产物已从后端工作区读取。",
        `${"a".repeat(12000)}\n...`,
      ].join("\n\n"),
    );

    expect(
      officeArtifactLoadedPanel({
        artifact,
        artifactPath: "/repo/client-brief.md",
        fileText: "file body",
        items: [{ label: "  client-brief.md", path: "/repo/client-brief.md", kind: "file" }],
        locale: "en",
        metadataText: "Type: file",
        searchRoot: "/repo",
      }),
    ).toMatchObject({
      title: "Client brief",
      subtitle: "/repo/client-brief.md",
      body: [
        "Office artifact loaded from the backend workspace.",
        "Type: file",
        "file body",
      ].join("\n\n"),
      actions: [
        { id: "copy-current-path", label: "Copy to .copy" },
        { id: "create-context-note", label: "New context note" },
        { id: "search-files", label: "Search", tone: "primary" },
        { id: "watch-current-path", label: "Watch" },
        { id: "unwatch-current-path", label: "Unwatch" },
        { id: "clear-file-search", label: "Clear" },
      ],
      items: [{ label: "  client-brief.md", path: "/repo/client-brief.md", kind: "file" }],
    });
  });
});
