import type { CompiledAgentVersion } from "@crewon/agent-version";
import type { AgentVersionRuntime } from "./agent-version-runtime.ts";
import type { AgentVersionRuntimeFactoryPort } from "./durable-agent-version-runtime-loader.ts";
import type {
  AgentRuntimeCapacity,
  AgentRuntimeReservation,
} from "./agent-runtime-capacity.ts";

export async function createAdmittedAgentRuntime(input: {
  capacity: AgentRuntimeCapacity;
  factory: AgentVersionRuntimeFactoryPort;
  tenantId: string;
  version: CompiledAgentVersion;
  ownership: "ownedRuntime" | "sharedProjection";
}): Promise<{
  runtime: AgentVersionRuntime;
  reservation: AgentRuntimeReservation | null;
}> {
  const reservation =
    input.ownership === "ownedRuntime"
      ? input.capacity.reserve(Buffer.byteLength(JSON.stringify(input.version)))
      : null;
  let cleaned = false;
  let failed = false;
  try {
    const runtime = await input.factory.create({
      tenantId: input.tenantId,
      version: input.version,
      failedCreationCleanup: {
        confirmReleased() {
          cleaned = true;
          if (failed) reservation?.release();
        },
      },
    });
    return { runtime, reservation };
  } catch (error) {
    failed = true;
    if (cleaned) reservation?.release();
    else reservation?.markUncertain();
    throw error;
  }
}

/** Disposal failure cannot return capacity to another creator. */
export async function closeAdmittedAgentRuntime(input: {
  runtime: AgentVersionRuntime;
  reservation: AgentRuntimeReservation | null;
}): Promise<void> {
  try {
    await input.runtime.close?.();
    input.reservation?.release();
  } catch (error) {
    input.reservation?.markUncertain();
    throw error;
  }
}
