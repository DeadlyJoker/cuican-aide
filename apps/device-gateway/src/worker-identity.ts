import type { IncomingMessage } from "node:http";

export type AuthenticatedWorkerIdentity = Readonly<{
  workerId: string;
  credentialId: string;
  authenticationMethod: "mtls";
  authenticatedAt: string;
}>;

export type GatewayAssertedWorkerIdentity = Readonly<{
  workerId: string;
  credentialId: string;
  authenticationMethod: "gatewayAssertion";
  assertingGatewayId: string;
  authenticatedAt: string;
}>;

export type WorkspaceWorkerIdentity =
  | AuthenticatedWorkerIdentity
  | GatewayAssertedWorkerIdentity;

/** Maps transport authentication to a configured Runtime Worker identity. */
export interface WorkerIdentityVerifierPort {
  verify(request: IncomingMessage): Promise<AuthenticatedWorkerIdentity>;
}
