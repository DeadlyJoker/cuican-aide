import { DeviceGatewayError } from "./device-gateway-error.ts";

export type DeviceExecutionCommandKind = "tool" | "workspaceList";

/**
 * In-memory prototype of the global execution-id namespace shared by all
 * Device command kinds. Claims are permanent, including after terminal state.
 */
export class InMemoryDeviceExecutionKindAuthority {
  readonly #kinds = new Map<string, DeviceExecutionCommandKind>();

  claim(executionId: string, kind: DeviceExecutionCommandKind): void {
    requireExecutionId(executionId);
    const current = this.#kinds.get(executionId);
    if (current !== undefined && current !== kind) {
      throw new DeviceGatewayError("device_dispatch_kind_conflict");
    }
    this.#kinds.set(executionId, kind);
  }

  kind(executionId: string): DeviceExecutionCommandKind | null {
    requireExecutionId(executionId);
    return this.#kinds.get(executionId) ?? null;
  }
}

function requireExecutionId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  ) {
    throw new DeviceGatewayError("device_execution_id_invalid");
  }
}
