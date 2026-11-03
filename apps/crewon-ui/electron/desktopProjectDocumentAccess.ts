import { parseProjectConversationContextResponse } from "@crewon/contracts/project-conversations";
import type { DesktopProjectDocumentTarget } from "../src/lib/desktop/desktopProjectDocuments.ts";
import type { LocalWorkspaceAuthority } from "./localWorkspaceRegistry.ts";
import { desktopNativeProjectDocuments } from "./desktopNativeProjectWorkspaceRuntime.ts";

export async function openDesktopProjectDocumentAccess(input: {
  owner: object;
  workspaces: LocalWorkspaceAuthority;
  target: DesktopProjectDocumentTarget;
  operation: "read" | "write";
  session(): {
    baseUrl: string;
    sessionToken: string;
    csrfToken: string;
    origin: string;
  };
  assertCurrent(): void;
}) {
  input.assertCurrent();
  const session = input.session();
  const response = await fetch(
    new URL(
      `api/v1/threads/${encodeURIComponent(input.target.threadId)}/project-conversation/document-access`,
      session.baseUrl,
    ),
    {
      method: "POST",
      headers: {
        "authorization": `Bearer ${session.sessionToken}`,
        "x-csrf-token": session.csrfToken,
        "origin": session.origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ operation: input.operation }),
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) throw new Error("project_document_access_denied");
  const { context } = parseProjectConversationContextResponse(
    input.target.threadId,
    await response.json(),
  );
  if (
    !context ||
    context.binding.projectId !== input.target.projectId ||
    (["pluginId", "publisherId", "version", "packageDigest"] as const).some(
      (key) =>
        context.binding.source[key] !== input.target.packageIdentity[key],
    )
  )
    throw new Error("project_document_binding_mismatch");
  if (!context.binding.workspaceId)
    throw new Error("project_document_workspace_required");
  input.assertCurrent();
  return desktopNativeProjectDocuments({
    owner: input.owner,
    workspaces: input.workspaces,
    target: input.target,
    expectedWorkspaceId: context.binding.workspaceId,
    async assertOperationCurrent(operation, projectId) {
      if (operation !== input.operation || projectId !== input.target.projectId)
        throw new Error("project_document_operation_mismatch");
      input.assertCurrent();
    },
  });
}
