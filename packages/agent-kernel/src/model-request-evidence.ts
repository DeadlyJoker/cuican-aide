import { createHash } from "node:crypto";
import { canonicalJsonValue } from "@crewon/contracts/runtime";

import type { ModelRequest } from "./model-transport-port.ts";

export type ModelRequestDispatchEvidence = Readonly<{
  requestSequence: number;
  operationId: string;
  operation: "dispatch" | "retrieve";
  requestDigest: string;
  provider: Readonly<{
    agentVersionId: string;
    adapterName: string;
    adapterVersion: string;
    modelId: string;
  }>;
}>;

export function modelRequestDispatchEvidence(
  request: ModelRequest,
  requestSequence: number,
  provider: Omit<ModelRequestDispatchEvidence["provider"], "agentVersionId">,
): ModelRequestDispatchEvidence {
  return {
    requestSequence,
    operationId: `${request.segmentId}:request:${requestSequence}`,
    operation:
      request.reconcileCheckpoint === undefined ? "dispatch" : "retrieve",
    requestDigest: `sha256:${createHash("sha256")
      .update(canonicalJsonValue(request))
      .digest("hex")}`,
    provider: { agentVersionId: request.agentVersionId, ...provider },
  };
}
