import type { IncomingMessage } from "node:http";

export type AuthenticatedGatewayIdentity = Readonly<{
  gatewayId: string;
  credentialId: string;
  authenticationMethod: "mtls";
  authenticatedAt: string;
}>;

/** Maps a peer mTLS connection to a statically registered Gateway identity. */
export interface GatewayIdentityVerifierPort {
  verify(request: IncomingMessage): Promise<AuthenticatedGatewayIdentity>;
}
