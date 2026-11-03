import { LocalProjectDocuments } from "@crewon/store/local-project-documents";
import { LocalWorkspaceAuthority } from "./localWorkspaceRegistry.ts";
import { LocalWorkspaceProjectAllocator } from "./localWorkspaceProjectAllocator.ts";
import {
  qualifyDesktopNativeProjectWorkspaceState,
  type DesktopNativeProjectWorkspaceState,
} from "./desktopNativeProjectWorkspaceState.ts";
import { captureDesktopNativePluginAuthorityOwner } from "./desktopNativePluginAuthority.ts";

/** Native file access uses the original project allocation, never a renderer path.
 * The caller must also supply the live Control operation grant; metadata is not a write grant. */
type Input = Readonly<{
  nativeAuthority: unknown;
  workspaces: LocalWorkspaceAuthority;
  expectedWorkspaceId?: string;
  assertOperationCurrent(
    operation: "read" | "write",
    projectId: string,
  ): Promise<void>;
}>;
export class DesktopNativeProjectDocuments {
  readonly #input: Input;
  constructor(input: Input) {
    this.#input = Object.freeze({
      ...input,
      assertOperationCurrent: input.assertOperationCurrent.bind(input),
    });
  }

  async read(state: DesktopNativeProjectWorkspaceState, documentId: string) {
    const store = await this.#store(state, "read");
    return store.read(documentId);
  }

  async save(
    state: DesktopNativeProjectWorkspaceState,
    request: Readonly<{
      documentId: string;
      expectedRevision: number;
      content: string;
    }>,
  ) {
    const captured = { ...request };
    const store = await this.#store(state, "write");
    return store.save(captured);
  }

  async subscribe(
    state: DesktopNativeProjectWorkspaceState,
    documentId: string,
    changed: () => void,
  ) {
    const store = await this.#store(state, "read");
    return store.subscribe(documentId, changed);
  }

  async #store(
    state: DesktopNativeProjectWorkspaceState,
    operation: "read" | "write",
  ) {
    const source = qualifyDesktopNativeProjectWorkspaceState(state);
    if (source.nativeAuthority !== this.#input.nativeAuthority)
      throw new Error("project_document_native_owner_mismatch");
    const pin = captureDesktopNativePluginAuthorityOwner(
      this.#input.nativeAuthority,
    );
    await this.#input.assertOperationCurrent(operation, source.owner.projectId);
    pin.assertCurrent();
    source.assertCurrent();
    const allocation = new LocalWorkspaceProjectAllocator(
      this.#input.workspaces,
      source.owner,
    ).inspect();
    if (
      allocation.phase !== "registered" ||
      allocation.observation !== "registered" ||
      allocation.failureCode !== null
    )
      throw new Error("project_document_workspace_unavailable");
    if (
      this.#input.expectedWorkspaceId !== undefined &&
      allocation.workspaceId !== this.#input.expectedWorkspaceId
    )
      throw new Error("project_document_workspace_mismatch");
    const root = LocalWorkspaceAuthority.prototype.root.call(
      this.#input.workspaces,
      allocation.workspaceId,
    );
    source.assertCurrent();
    return new LocalProjectDocuments(root);
  }
}
