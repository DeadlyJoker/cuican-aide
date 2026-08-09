import type { IncomingMessage } from "node:http";

export type AuthenticatedDeviceIdentity = Readonly<{
  deviceId: string;
  credentialId: string;
  authenticationMethod: "mtls" | "deviceKey";
  authenticatedAt: string;
}>;

/** Resolves an identity that was cryptographically authenticated at the WSS boundary. */
export interface DeviceIdentityVerifierPort {
  verify(request: IncomingMessage): Promise<AuthenticatedDeviceIdentity>;
}
