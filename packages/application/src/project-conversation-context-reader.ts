import {
  assertCreativeProjectScope,
  assertProjectStructuredOutlineInputs,
  extensionCanonicalJson,
  parseProjectTextArtifact,
  ProjectTextError,
  validateProjectFoundation,
  type ProjectConversationBinding,
} from "@crewon/domain";
import type {
  ProjectConversationContext,
  ProjectConversationContextResponse,
  ProjectConversationsResponses,
} from "@crewon/contracts/project-conversations";
import type { ProjectConversationApplicationDependencies } from "./project-conversation-application-service.ts";
import type { ProjectConversationCommitAuthority } from "./project-conversation-store-port.ts";
import {
  qualifyPluginProjectReadScope,
  type PluginProjectReadScope,
} from "./plugin-project-read-scope.ts";
import { ApplicationError } from "./application-error.ts";
import { creativeOwner } from "./creative-project-application-support.ts";
import {
  readConversationProject,
  authorizeConversationProject,
} from "./project-conversation-project-reader.ts";
import { readProjectOutlineSourceRevision } from "./project-outline-source-reader.ts";
import { readProjectConversationBinding } from "./project-conversation-binding-reader.ts";
import { projectConversationPublicBinding } from "./project-conversation-projection.ts";
import {
  captureProjectConversationAuthority,
  assertProjectConversationActor,
} from "./project-conversation-authority.ts";
import type { ActorContext } from "./authorization-port.ts";

export async function readProjectConversationContextResponse(
  input: Readonly<{
    dependencies: ProjectConversationApplicationDependencies;
    actor: ActorContext;
    authority: ProjectConversationCommitAuthority;
    projectReadScope?: PluginProjectReadScope;
    readBinding(
      authority: ProjectConversationCommitAuthority,
    ): Promise<ProjectConversationsResponses["getBinding"]>;
  }>,
): Promise<ProjectConversationContextResponse> {
  const q = captureProjectConversationAuthority(input.authority);
  assertProjectConversationActor(input.actor, q);
  await q.assertCurrent();
  const { binding } = await input.readBinding(q);
  if (binding === null) return { context: null };
  if (binding.state !== "active")
    throw new ApplicationError(
      "conflict",
      "project_conversation_source_mismatch",
    );
  const context = await readProjectConversationContext({
    dependencies: input.dependencies,
    authority: q,
    binding,
    ...(input.projectReadScope === undefined
      ? {}
      : { projectReadScope: input.projectReadScope }),
  });
  if (
    extensionCanonicalJson((await input.readBinding(q)).binding) !==
    extensionCanonicalJson(binding)
  )
    throw new ApplicationError(
      "conflict",
      "project_conversation_source_mismatch",
    );
  return { context };
}

export async function readProjectConversationPublicBinding(
  input: Readonly<{
    dependencies: ProjectConversationApplicationDependencies;
    authority: ProjectConversationCommitAuthority;
    threadId: string;
    projects: Pick<
      ProjectConversationApplicationDependencies["projects"],
      "loadProject"
    >;
    readThread(binding: ProjectConversationBinding): Promise<void>;
  }>,
) {
  const d = input.dependencies,
    q = input.authority;
  const binding = await readProjectConversationBinding({
    authority: q,
    threadId: input.threadId,
    conversations: d.conversations,
    readProject: (projectId) =>
      readConversationProject({
        authority: q,
        projectId,
        action: "creativeProject:read",
        authorization: d.authorization,
        projects: input.projects,
      }),
    readThread: input.readThread,
    assertProjectCurrent: (projectId) =>
      authorizeConversationProject({
        authority: q,
        projectId,
        action: "creativeProject:read",
        authorization: d.authorization,
      }),
  });
  return {
    binding:
      binding === null
        ? null
        : projectConversationPublicBinding(binding, d.digester),
  };
}

/** Explicit per-call view correlated with the real Host pin and actual selected Thread. */
export async function conversationContextProjectReader(
  input: Readonly<{
    projects: ProjectConversationApplicationDependencies["projects"];
    authority: ProjectConversationCommitAuthority;
    threadId: string;
    scope: PluginProjectReadScope;
  }>,
) {
  const source = qualifyPluginProjectReadScope(input.scope);
  if (
    source.purpose !== "read" ||
    source.request.action !== "crewon.project-conversation-context.v1" ||
    source.request.input.threadId !== input.threadId ||
    extensionCanonicalJson(source.snapshot.pin) !==
      extensionCanonicalJson(input.authority.pin) ||
    extensionCanonicalJson(source.snapshot.context.selection) !==
      extensionCanonicalJson(input.authority.selection) ||
    extensionCanonicalJson(source.snapshot.context.package) !==
      extensionCanonicalJson(input.authority.package) ||
    !input.projects.bindProjectReads
  )
    denied();
  await source.assertCurrent();
  source.assertActive();
  return input.projects.bindProjectReads(input.scope);
}

/** Reads only adopted, current sources. Full text remains in the original project services. */
export async function readProjectConversationContext(
  input: Readonly<{
    dependencies: ProjectConversationApplicationDependencies;
    authority: ProjectConversationCommitAuthority;
    binding: ProjectConversationContext["binding"];
    projectReadScope?: PluginProjectReadScope;
  }>,
): Promise<ProjectConversationContext> {
  const d = input.dependencies,
    q = input.authority,
    b = input.binding;
  const scope = input.projectReadScope;
  const projects =
    scope === undefined
      ? d.projects
      : await conversationContextProjectReader({
          projects: d.projects,
          authority: q,
          threadId: b.threadId,
          scope,
        });
  const project = await readConversationProject({
    authority: q,
    projectId: b.projectId,
    action: "creativeProject:read",
    projects,
    authorization: d.authorization,
  });
  const owner = creativeOwner(q.actor),
    locator = { owner, projectId: project.projectId };
  if (scope !== undefined && !d.texts.bindProjectReads) denied();
  const texts =
    scope === undefined ? d.texts : d.texts.bindProjectReads!(scope);
  const rawHead = await texts.loadOutline(locator);
  let outline: ProjectConversationContext["outline"] = null;
  if (rawHead !== null) {
    const head = parseProjectTextArtifact(rawHead);
    assertCreativeProjectScope(project, head);
    if (head.kind !== "outline") denied();
    if (head.selectedContentRevision !== null) {
      const selected = await readProjectOutlineSourceRevision({
        store: texts,
        scope: locator,
        project,
        artifact: head,
        contentRevision: head.selectedContentRevision,
        digester: d.digester,
      });
      let current =
        selected.brief.briefRevision === project.latestBriefRevision;
      if (
        current &&
        selected.schemaVersion === "crewon.project-text-revision.v2"
      ) {
        if (d.foundations === undefined) current = false;
        else {
          if (scope !== undefined && !d.foundations.bindProjectReads) denied();
          const foundations =
            scope === undefined
              ? d.foundations
              : d.foundations.bindProjectReads!(scope);
          const rawFoundation = await foundations.loadFoundation(locator);
          if (rawFoundation === null) current = false;
          else {
            const foundation = validateProjectFoundation(rawFoundation);
            assertCreativeProjectScope(project, foundation);
            try {
              assertProjectStructuredOutlineInputs(
                selected,
                foundation,
                d.digester,
              );
            } catch (error) {
              if (!(error instanceof ProjectTextError)) throw error;
              current = false;
            }
          }
        }
      }
      if (current)
        outline = Object.freeze({
          artifactId: head.artifactId,
          contentRevision: selected.contentRevision,
          episodes: Object.freeze(
            selected.content.episodes.map(({ episodeId, title }) =>
              Object.freeze({ episodeId, title }),
            ),
          ),
        });
    }
  }
  await q.assertCurrent();
  await authorizeConversationProject({
    authority: q,
    projectId: b.projectId,
    action: "creativeProject:read",
    authorization: d.authorization,
  });
  q.assertActive();
  return Object.freeze({
    binding: b,
    projectRevision: project.revision,
    briefRevision: project.latestBriefRevision,
    outline,
  });
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "project_conversation_context_scope_mismatch",
  );
}
