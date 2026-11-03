import type { ActorContext } from "@crewon/application";
import {
  LocalProjectDocuments,
  type LocalProjectDocument,
} from "@crewon/store";

export type ProjectDocumentAccess = Readonly<{
  root: string;
  /** Recheck the actual host grant immediately before filesystem access. */
  assertCurrent(): void;
}>;
export type ProjectDocumentChange = Readonly<{
  projectId: string;
  documentId: string;
  revision: number;
  digest: string;
}>;

/** One content owner for both UI and Agent. Caller-provided paths are never accepted. */
export type ProjectDocumentAuthorizer = (
  input: Readonly<{
    actor: ActorContext;
    projectId: string;
    operation: "read" | "write";
  }>,
) => Promise<ProjectDocumentAccess>;

export class LocalProjectDocumentOwner {
  readonly #authorize: ProjectDocumentAuthorizer;
  readonly #listeners = new Map<
    string,
    Set<(event: ProjectDocumentChange) => void>
  >();

  constructor(authorize: ProjectDocumentAuthorizer) {
    this.#authorize = authorize;
  }

  async read(
    actor: ActorContext,
    input: Readonly<{ projectId: string; documentId: string }>,
  ): Promise<LocalProjectDocument | null> {
    const request = {
      projectId: input.projectId,
      documentId: input.documentId,
    };
    const access = await this.#access(actor, request.projectId, "read");
    access.assertCurrent();
    return new LocalProjectDocuments(access.root).read(request.documentId);
  }

  async save(
    actor: ActorContext,
    input: Readonly<{
      projectId: string;
      documentId: string;
      expectedRevision: number;
      content: string;
    }>,
  ): Promise<LocalProjectDocument> {
    const request = { ...input };
    const who = Object.freeze({ ...actor });
    const access = await this.#access(who, request.projectId, "write");
    access.assertCurrent();
    const store = new LocalProjectDocuments(access.root);
    const before = store.read(request.documentId);
    const saved = store.save(request);
    if (before?.revision !== saved.revision) {
      const event = Object.freeze({
        projectId: request.projectId,
        documentId: saved.documentId,
        revision: saved.revision,
        digest: saved.digest,
      });
      for (const listener of this.#listeners.get(
        this.#key(who, request.projectId),
      ) ?? []) {
        // A disconnected view must not turn a committed file write into a failed save.
        try {
          listener(event);
        } catch {
          /* View reload reconciles from files. */
        }
      }
    }
    return saved;
  }

  async subscribe(
    actor: ActorContext,
    projectId: string,
    listener: (event: ProjectDocumentChange) => void,
  ): Promise<() => void> {
    const who = Object.freeze({ ...actor });
    const access = await this.#access(who, projectId, "read");
    access.assertCurrent();
    const key = this.#key(who, projectId);
    const listeners = this.#listeners.get(key) ?? new Set();
    const guarded = (event: ProjectDocumentChange) => {
      access.assertCurrent();
      listener(event);
    };
    listeners.add(guarded);
    this.#listeners.set(key, listeners);
    return () => {
      listeners.delete(guarded);
      if (listeners.size === 0) this.#listeners.delete(key);
    };
  }

  #key(actor: ActorContext, projectId: string): string {
    return JSON.stringify([
      actor.tenantId,
      actor.spaceId,
      actor.principalId,
      projectId,
    ]);
  }

  #access(actor: ActorContext, projectId: string, operation: "read" | "write") {
    if (
      typeof projectId !== "string" ||
      projectId.length === 0 ||
      projectId.length > 128
    )
      throw new Error("project_document_project_invalid");
    return this.#authorize({
      actor: Object.freeze({ ...actor }),
      projectId,
      operation,
    });
  }
}
