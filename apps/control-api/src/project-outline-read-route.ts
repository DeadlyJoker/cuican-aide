import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  ApplicationError,
  projectOutlinePublicSection,
  projectOutlinePublicSummary,
  projectOutlinePublicView,
  type ProjectStructuredOutlineApplicationService,
} from "@crewon/application";
import {
  parseProjectOutlineUiRequest,
  parseProjectOutlineUiResponse,
  PROJECT_OUTLINE_UI_METHOD_ACTIONS as actions,
} from "@crewon/contracts/project-outlines";
import { parseProjectTextEmptyQuery } from "@crewon/contracts";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";

const ROOT = "/api/v2/creative-projects/:projectId/outline";
type Params = { projectId: string };

/** Authenticated, bounded reads of the original outline slot. No mutation or execution port. */
export function registerProjectOutlineReadRoutes(
  app: FastifyInstance,
  input: Readonly<{
    identity: ControlApiIdentityPort;
    outlines: ProjectStructuredOutlineApplicationService;
  }>,
): void {
  const actor = (request: FastifyRequest) =>
    input.identity.resolveActor(requestContext(request));
  app.get<{ Params: Params; Querystring: unknown }>(
    ROOT,
    { exposeHeadRoute: false },
    async (request) => {
      parseProjectTextEmptyQuery(request.query);
      const command = parse({
        action: actions.getOutline,
        input: { projectId: request.params.projectId },
      });
      if (command.action !== actions.getOutline) invalid();
      return parseProjectOutlineUiResponse(command, {
        view: projectOutlinePublicView(
          await input.outlines.getOutline(await actor(request), command.input),
        ),
      });
    },
  );
  app.get<{ Params: Params; Querystring: unknown }>(
    `${ROOT}/sections`,
    { exposeHeadRoute: false },
    async (request) => {
      const command = parse({
        action: actions.getSection,
        input: query(request.params.projectId, request.query, [
          "contentRevision",
          "afterIndex",
          "limit",
        ]),
      });
      if (command.action !== actions.getSection) invalid();
      const { projectId, artifactId, contentRevision } = command.input;
      const revision = await input.outlines.getRevision(await actor(request), {
        projectId,
        artifactId,
        contentRevision,
      });
      return parseProjectOutlineUiResponse(
        command,
        projectOutlinePublicSection(revision, command.input),
      );
    },
  );
  app.get<{ Params: Params; Querystring: unknown }>(
    `${ROOT}/revisions`,
    { exposeHeadRoute: false },
    async (request) => {
      const command = parse({
        action: actions.listRevisions,
        input: query(request.params.projectId, request.query, [
          "afterContentRevision",
          "limit",
        ]),
      });
      if (command.action !== actions.listRevisions) invalid();
      const page = await input.outlines.listRevisions(
        await actor(request),
        command.input,
      );
      return parseProjectOutlineUiResponse(command, {
        revisions: page.revisions.map(projectOutlinePublicSummary),
        nextContentRevision: page.nextContentRevision,
      });
    },
  );
}
function parse(input: unknown) {
  try {
    return parseProjectOutlineUiRequest(input);
  } catch {
    return invalid();
  }
}
function query(projectId: string, raw: unknown, numbers: readonly string[]) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const fields = raw as Record<string, unknown>;
  if (Object.hasOwn(fields, "projectId")) invalid();
  const result: Record<string, unknown> = { projectId };
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== "string") invalid();
    if (numbers.includes(key)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(value)) invalid();
      result[key] = Number(value);
    } else result[key] = value;
  }
  return result;
}
function invalid(): never {
  throw new ApplicationError("validation", "project_outline_request_invalid");
}
