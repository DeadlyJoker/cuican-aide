import type { ChildProcess } from "node:child_process";
import { captureDesktopNativePluginAuthorityOwner } from "./desktopNativePluginAuthority.ts";
import { DesktopNativeProjectWorkspaceBridge } from "./desktopNativeProjectWorkspaceBridge.ts";
import { LocalWorkspaceAuthority } from "./localWorkspaceRegistry.ts";
import { LocalProjectDocuments } from "@crewon/store/local-project-documents";
import { DesktopNativeProjectDocuments } from "./desktopNativeProjectDocuments.ts";
import { captureDesktopNativeProjectWorkspaceState } from "./desktopNativeProjectWorkspaceState.ts";
import type { DesktopProjectDocumentTarget } from "../src/lib/desktop/desktopProjectDocuments.ts";

const owners = new WeakMap<
  object,
  Readonly<{ nativeAuthority: unknown; assertCurrent(): void }>
>();

/** Shared with the original runtime owner, never a path supplied by a renderer. */
export function desktopNativeProjectDocuments(input: {
  owner: object;
  workspaces: LocalWorkspaceAuthority;
  target: DesktopProjectDocumentTarget;
  expectedWorkspaceId: string;
  assertOperationCurrent(
    operation: "read" | "write",
    projectId: string,
  ): Promise<void>;
}) {
  const source = owners.get(input.owner);
  if (!source) throw new Error("project_document_owner_unavailable");
  source.assertCurrent();
  const pin = captureDesktopNativePluginAuthorityOwner(source.nativeAuthority);
  if (
    !pin.packages.some(
      (pkg) =>
        pkg.approvalRequirement === "none" &&
        (
          ["pluginId", "publisherId", "version", "packageDigest"] as const
        ).every((key) => pkg[key] === input.target.packageIdentity[key]),
    )
  )
    throw new Error("project_document_package_denied");
  const authorize = async (operation: "read" | "write") => {
    source.assertCurrent();
    await input.assertOperationCurrent(operation, input.target.projectId);
    source.assertCurrent();
  };
  // Existing projects may already use an explicitly selected ordinary workspace.
  // Keep that original binding. A null binding never borrows the active folder.
  if (
    LocalWorkspaceAuthority.prototype.ordinaryStatus
      .call(input.workspaces)
      .workspaces.some(
        (entry) => entry.workspaceId === input.expectedWorkspaceId,
      ) ||
    LocalWorkspaceAuthority.prototype.ordinaryStatus
      .call(input.workspaces)
      .archivedWorkspaceIds?.includes(input.expectedWorkspaceId)
  ) {
    const root = LocalWorkspaceAuthority.prototype.root.call(
      input.workspaces,
      input.expectedWorkspaceId,
    );
    const store = new LocalProjectDocuments(root);
    const current = async (operation: "read" | "write") => {
      await authorize(operation);
      if (
        LocalWorkspaceAuthority.prototype.root.call(
          input.workspaces,
          input.expectedWorkspaceId,
        ) !== root
      )
        throw new Error("project_document_workspace_changed");
    };
    return {
      async read(documentId: string) {
        await current("read");
        return store.read(documentId);
      },
      async save(request: {
        documentId: string;
        content: string;
        expectedRevision: number;
      }) {
        await current("write");
        return store.save(request);
      },
      async subscribe(documentId: string, changed: () => void) {
        await current("read");
        return store.subscribe(documentId, changed);
      },
    };
  }
  const state = captureDesktopNativeProjectWorkspaceState({
    nativeAuthority: source.nativeAuthority,
    projectId: input.target.projectId,
    packageIdentity: input.target.packageIdentity,
  });
  const documents = new DesktopNativeProjectDocuments({
    nativeAuthority: source.nativeAuthority,
    workspaces: input.workspaces,
    expectedWorkspaceId: input.expectedWorkspaceId,
    async assertOperationCurrent(operation, projectId) {
      source.assertCurrent();
      await input.assertOperationCurrent(operation, projectId);
      source.assertCurrent();
    },
  });
  return {
    read: (documentId: string) => documents.read(state, documentId),
    save: (request: {
      documentId: string;
      content: string;
      expectedRevision: number;
    }) => documents.save(state, request),
    subscribe: (documentId: string, changed: () => void) =>
      documents.subscribe(state, documentId, changed),
  };
}
/** Trusted Native runtime producer only; no serializable authority or renderer field is added. */
export function bindDesktopNativeProjectWorkspaceRuntime(
  input: Readonly<{
    owner: object;
    nativeAuthority: unknown;
    assertCurrent(): void;
  }>,
): void {
  captureDesktopNativePluginAuthorityOwner(input.nativeAuthority);
  input.assertCurrent();
  if (owners.has(input.owner))
    throw new Error("desktop_native_project_workspace_runtime_duplicate");
  owners.set(
    input.owner,
    Object.freeze({
      nativeAuthority: input.nativeAuthority,
      assertCurrent: input.assertCurrent.bind(input),
    }),
  );
}
export function attachDesktopNativeProjectWorkspaceRuntime(
  input: Readonly<{
    owner: object;
    workspaces: LocalWorkspaceAuthority;
    control: ChildProcess;
    signal: AbortSignal;
  }>,
): DesktopNativeProjectWorkspaceBridge | undefined {
  const source = owners.get(input.owner);
  if (!source) return undefined;
  source.assertCurrent();
  const bridge = new DesktopNativeProjectWorkspaceBridge({
    nativeAuthority: source.nativeAuthority,
    workspaces: input.workspaces,
    control: input.control,
    signal: input.signal,
  });
  try {
    source.assertCurrent();
    return bridge;
  } catch (error) {
    void bridge.close();
    throw error;
  }
}
