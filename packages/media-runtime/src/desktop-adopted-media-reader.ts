import {
  ApplicationError,
  type ActorContext,
  type ApplicationClock,
  type ProjectMediaWorkflowReview,
  type ProjectMediaResultAuthorizationPort,
  type ProjectAdoptedMediaMaterialFreezeAuthorizationPort,
} from "@crewon/application";
import { FilesystemProjectMediaResultArchive } from "@crewon/artifacts";
import type { SqliteRunStore, PostgresDomainStore } from "@crewon/store";
import type { PluginProfileScope } from "@crewon/domain";
import { loadDesktopProjectResultArchive } from "./desktop-project-result-archive.ts";
import type { DesktopProjectMaterialStorage } from "./desktop-project-material-archive.ts";
import { ProjectMediaResultPublisher } from "./project-media-result-publisher.ts";
/** Saved output reader shared by native Control/Worker. Publication and provider I/O remain denied. */
export async function createDesktopAdoptedMediaReader(
  input: Readonly<{
    store: SqliteRunStore | PostgresDomainStore;
    storage: DesktopProjectMaterialStorage;
    scope: PluginProfileScope;
    reviews: readonly ProjectMediaWorkflowReview[];
    materialArchiveId: string;
    clock: ApplicationClock;
    signal: AbortSignal;
    assertCurrent(actor: ActorContext): Promise<void>;
    assertActive(actor: ActorContext): void;
  }>,
) {
  let closed = false;
  const active = (actor: ActorContext) => {
    if (closed) denied();
    input.signal.throwIfAborted();
    input.assertActive(actor);
  };
  input.signal.throwIfAborted();
  const store = input.store.extensionStore().projectMediaResults();
  await store.enableResultReads();
  input.signal.throwIfAborted();
  const config = loadDesktopProjectResultArchive(input.storage, input.scope);
  let archive: FilesystemProjectMediaResultArchive | undefined;
  try {
    archive = new FilesystemProjectMediaResultArchive(config);
    const read: ProjectMediaResultAuthorizationPort = {
      authorize: async (p) => {
        active(p.actor);
        if (p.action !== "projectMediaResult:read") denied();
        await input.assertCurrent(p.actor);
        active(p.actor);
        return { outcome: "allow" };
      },
      assertActive: (p) => {
        active(p.actor);
        if (p.action !== "projectMediaResult:read") denied();
      },
    };
    const results = new ProjectMediaResultPublisher({
      store,
      archive,
      authorization: read,
      reviews: input.reviews,
      clock: input.clock,
      outputApproval: { assertCurrent: async () => denied() },
      transport: { request: async () => denied() },
    });
    const freeze: ProjectAdoptedMediaMaterialFreezeAuthorizationPort = {
      authorize: async (p) => {
        active(p.actor);
        if (
          p.action !== "projectReferenceMaterial:freeze" ||
          p.resource.archiveId !== input.materialArchiveId
        )
          denied();
        await input.assertCurrent(p.actor);
        active(p.actor);
        return { outcome: "allow" };
      },
    };
    const owned = archive;
    let closing: Promise<void> | undefined;
    return Object.freeze({
      config: Object.freeze({ results, read, freeze }),
      close: () =>
        (closing ??= (async () => {
          closed = true;
          try {
            await results.close();
          } finally {
            owned.close();
          }
        })()),
    });
  } catch (e) {
    archive?.close();
    throw e;
  } finally {
    config.encryptionKey.fill(0);
  }
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "desktop_adopted_media_read_only",
  );
}
