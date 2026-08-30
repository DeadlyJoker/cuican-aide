import type { JsonValue } from "@crewon/app-server-protocol/serde_json/JsonValue";
import type { ResourceContent } from "@crewon/app-server-protocol/ResourceContent";

import type { LibraryPanel, LibraryPanelAction } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import { mcpOauthLoginPanel } from "./libraryActionPresentation";
import {
  mcpResourceBody,
  mcpResourceReadResultPanel,
  mcpResourceRecordText,
  mcpResourceRecordTitle,
  mcpResourceRecordWarningText,
  mcpToolArgumentsErrorPanel,
  mcpToolArgumentsPayload,
  mcpToolCallRecordText,
  mcpToolCallRecordTitle,
  mcpToolCallResultPanel,
  mcpToolRecordWarningText,
  mcpToolThreadUnavailablePanel,
} from "../mcp/mcpResultPresentation";

type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

export type LibraryMcpActionParams = {
  action: LibraryPanelAction;
  callMcpTool: (
    threadId: string,
    serverName: string,
    toolName: string,
    args: JsonValue | undefined,
  ) => Promise<unknown>;
  ensureBackendToolThread: (
    serverName: string,
    toolName: string,
  ) => Promise<string | null>;
  libraryPanel: LibraryPanel | null;
  locale: Locale;
  readMcpResource: (
    serverName: string,
    uri: string,
    threadId: string | undefined,
  ) => Promise<{ contents?: ResourceContent[] } | null | undefined>;
  recordBackendToolEvent: (
    threadId: string,
    title: string,
    body: string,
  ) => Promise<void>;
  resourceContextThreadId: string | undefined;
  setLibraryPanel: LibraryPanelSetter;
  startMcpOauthLogin: (
    serverName: string,
  ) => Promise<{ authorizationUrl?: string | null } | null | undefined>;
};

export async function handleLibraryMcpAction({
  action,
  callMcpTool,
  ensureBackendToolThread,
  libraryPanel,
  locale,
  readMcpResource,
  recordBackendToolEvent,
  resourceContextThreadId,
  setLibraryPanel,
  startMcpOauthLogin,
}: LibraryMcpActionParams): Promise<boolean> {
  if (action.id === "login-mcp-oauth") {
    if (!action.mcpServerName) {
      return true;
    }
    const response = await startMcpOauthLogin(action.mcpServerName);
    setLibraryPanel((currentPanel) =>
      mcpOauthLoginPanel(currentPanel, response, locale),
    );
    return true;
  }

  if (action.id === "call-mcp-tool") {
    if (!action.mcpServerName || !action.mcpToolName) {
      return true;
    }
    const toolThreadId = await ensureBackendToolThread(
      action.mcpServerName,
      action.mcpToolName,
    );
    if (!toolThreadId) {
      setLibraryPanel((currentPanel) =>
        mcpToolThreadUnavailablePanel(currentPanel, locale),
      );
      return true;
    }

    let parsedArgs: JsonValue | undefined;
    try {
      parsedArgs = mcpToolArgumentsPayload(libraryPanel);
    } catch (error) {
      setLibraryPanel((currentPanel) =>
        mcpToolArgumentsErrorPanel(currentPanel, error, locale),
      );
      return true;
    }

    const response = await callMcpTool(
      toolThreadId,
      action.mcpServerName,
      action.mcpToolName,
      parsedArgs,
    );
    let recordWarning: string | null = null;
    try {
      await recordBackendToolEvent(
        toolThreadId,
        mcpToolCallRecordTitle({
          locale,
          server: action.mcpServerName,
          tool: action.mcpToolName,
        }),
        mcpToolCallRecordText({
          args: parsedArgs,
          locale,
          response,
          server: action.mcpServerName,
          tool: action.mcpToolName,
        }),
      );
    } catch (error) {
      recordWarning =
        error instanceof Error ? error.message : mcpToolRecordWarningText(locale);
    }
    setLibraryPanel((currentPanel) =>
      mcpToolCallResultPanel(currentPanel, {
        locale,
        recordWarning,
        response,
        threadId: toolThreadId,
      }),
    );
    return true;
  }

  if (action.id === "read-mcp-resource") {
    if (!action.mcpResourceServer || !action.mcpResourceUri) {
      return true;
    }
    const resourceThreadId = await ensureBackendToolThread(
      action.mcpResourceServer,
      "resource",
    );
    const response = await readMcpResource(
      action.mcpResourceServer,
      action.mcpResourceUri,
      resourceContextThreadId,
    );
    const contents = response?.contents ?? [];
    const body = mcpResourceBody(contents, locale);
    let recordWarning: string | null = null;
    if (resourceThreadId) {
      try {
        await recordBackendToolEvent(
          resourceThreadId,
          mcpResourceRecordTitle({
            locale,
            server: action.mcpResourceServer,
          }),
          mcpResourceRecordText({
            body,
            locale,
            uri: action.mcpResourceUri,
          }),
        );
      } catch (error) {
        recordWarning =
          error instanceof Error
            ? error.message
            : mcpResourceRecordWarningText(locale);
      }
    }
    setLibraryPanel((currentPanel) =>
      mcpResourceReadResultPanel(currentPanel, {
        body,
        locale,
        recordWarning,
        threadId: resourceThreadId,
      }),
    );
    return true;
  }

  return false;
}
