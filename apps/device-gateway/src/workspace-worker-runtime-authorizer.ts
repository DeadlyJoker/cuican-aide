import type { WorkerRegistration } from "./device-registry-config.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import type { WorkspaceWorkerIdentity } from "./worker-identity.ts";

/** Binds an authenticated Worker credential to explicitly allowed runtimes. */
export interface WorkspaceWorkerRuntimeAuthorizerPort {
  authorize(identity: WorkspaceWorkerIdentity, runtimeBindingId: string): void;
}

export class WorkspaceWorkerRuntimeAuthorizer
  implements WorkspaceWorkerRuntimeAuthorizerPort
{
  readonly #registrations: ReadonlyMap<string, WorkerRegistration>;

  constructor(registrations: readonly WorkerRegistration[]) {
    this.#registrations = new Map(
      registrations.map((registration) => [
        registration.workerId,
        structuredClone(registration),
      ]),
    );
  }

  authorize(identity: WorkspaceWorkerIdentity, runtimeBindingId: string): void {
    const registration = this.#registrations.get(identity.workerId);
    if (
      registration === undefined ||
      registration.credentialId !== identity.credentialId ||
      !(registration.allowedRuntimeBindingIds ?? []).includes(runtimeBindingId)
    ) {
      throw new DeviceGatewayError("workspace_worker_runtime_unauthorized");
    }
  }
}
