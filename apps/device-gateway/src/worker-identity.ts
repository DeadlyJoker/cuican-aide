import type { IncomingMessage } from "node:http";

export type AuthenticatedWorkerIdentity = Readonly<{
  workerId: string;
  credentialId: string;
  authenticationMethod: "mtls";
  authenticatedAt: string;
}>;

/** Maps transport authentication to a configured Runtime Worker identity. */
export interface WorkerIdentityVerifierPort {
  verify(request: IncomingMessage): Promise<AuthenticatedWorkerIdentity>;
}
