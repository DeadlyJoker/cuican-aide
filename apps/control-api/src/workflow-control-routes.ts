import type { FastifyInstance } from "fastify";
import { ApplicationError } from "@crewon/application";
import type {
  WorkflowHumanGateApplicationService,
  WorkflowRunQueryService,
  WorkflowRunApplicationService,
} from "@crewon/application";
import {
  parseRunId,
  parseWorkflowGateLocator,
  parseDecideWorkflowHumanGateRequest,
  parseWorkflowRunSnapshotResponse,
  parseWorkflowHumanGateResponse,
  parseWorkflowHumanGateMutationResponse,
  parseWorkflowExecutionCapability,
} from "@crewon/contracts";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { WorkspaceControlUnavailableError } from "./control-api-errors.ts";
import { requestContext } from "./request-context.ts";

export type WorkflowControlServices = {
  workflowQueries?: Pick<
    WorkflowRunQueryService,
    "getWorkflowRunSnapshot"
  > | null;
  workflowHumanGates?: Pick<
    WorkflowHumanGateApplicationService,
    "getGate" | "decideGate"
  > | null;
};
type WorkflowControlRouteDependencies = WorkflowControlServices & {
  identity: ControlApiIdentityPort;
  workflowRuns?: Pick<WorkflowRunApplicationService, "startWorkflowRun"> | null;
  workflowGateCommitted?: () => void;
};

/** Query endpoints have no scheduling side effects. Gate commands use the frozen request as their receipt identity. */
export function registerWorkflowControlRoutes(
  app: FastifyInstance,
  dependencies: WorkflowControlRouteDependencies,
): void {
  app.get(
    "/api/v1/capabilities/workflow-execution-v1",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      await dependencies.identity.resolveActor(requestContext(request));
      const snapshots = dependencies.workflowQueries != null;
      const humanGates = dependencies.workflowHumanGates != null;
      return parseWorkflowExecutionCapability({
        version: "v1",
        admission: dependencies.workflowRuns != null,
        snapshots,
        humanGates,
      });
    },
  );
  app.get<{ Params: { runId: string } }>(
    "/api/v1/workflow-runs/:runId",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const runId = parseRunId(request.params.runId);
      if (!dependencies.workflowQueries)
        throw new WorkspaceControlUnavailableError();
      const snapshot =
        await dependencies.workflowQueries.getWorkflowRunSnapshot(actor, runId);
      return project(() => parseWorkflowRunSnapshotResponse(snapshot, runId));
    },
  );
  type GateParams = { runId: string; nodeId: string; gateRequestId: string };
  const gatePath =
    "/api/v1/workflow-runs/:runId/nodes/:nodeId/gates/:gateRequestId";
  app.get<{ Params: GateParams }>(gatePath, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    const locator = parseWorkflowGateLocator({
      runId: request.params.runId,
      nodeId: request.params.nodeId,
      gateRequestId: request.params.gateRequestId,
    });
    if (!dependencies.workflowHumanGates)
      throw new WorkspaceControlUnavailableError();
    const view = await dependencies.workflowHumanGates.getGate(actor, locator);
    return project(() =>
      parseWorkflowHumanGateResponse(
        { schemaVersion: "crewon.workflow-human-gate.v0", ...view },
        locator,
      ),
    );
  });
  app.post<{ Params: GateParams; Body: unknown }>(
    `${gatePath}/decisions`,
    { bodyLimit: 4096 },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const locator = parseWorkflowGateLocator({
        runId: request.params.runId,
        nodeId: request.params.nodeId,
        gateRequestId: request.params.gateRequestId,
      });
      const body = parseDecideWorkflowHumanGateRequest(request.body);
      if (!dependencies.workflowHumanGates)
        throw new WorkspaceControlUnavailableError();
      const result = await dependencies.workflowHumanGates.decideGate(actor, {
        kind: "workflowHumanGate.decide",
        ...locator,
        ...body,
      });
      const response = project(() =>
        parseWorkflowHumanGateMutationResponse(result, locator, body),
      );
      if (response.disposition === "committed")
        dependencies.workflowGateCommitted?.();
      return response;
    },
  );
}

function project<T>(operation: () => T): T {
  try {
    return operation();
  } catch (cause) {
    throw new ApplicationError(
      "internal",
      "workflow_control_projection_invalid",
      { cause },
    );
  }
}
