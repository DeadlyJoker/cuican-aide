import type { IncomingMessage } from "node:http";

import {
  DEVICE_PROTOCOL_VERSION,
  type DeviceFilesystemReadRouteIntent,
} from "@crewon/contracts";
import type { DeviceWorkspaceListPeerRoute } from "@crewon/contracts";
import type WebSocket from "ws";

import {
  requireLeaseDuration,
  validateDeviceId,
  validateGatewayId,
  type DeviceConnectionRoute,
  type DeviceConnectionRouteStorePort,
} from "./device-connection-route-store.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import type { DeviceCommandAuthorizationVerifierPort } from "./device-command-authorization-verifier.ts";
import { DeviceGatewaySession } from "./device-gateway-session.ts";
import type { WorkspaceSessionEventCommitter } from "./device-gateway-workspace-session.ts";
import type { DeviceIdentityVerifierPort } from "./device-identity.ts";

const DEFAULT_CONNECTION_LEASE_MS = 30_000;

export type DeviceGatewayHeartbeatScheduler = Readonly<{
  every(intervalMs: number, callback: () => void): () => void;
}>;

export type DeviceGatewayConnectionRouteConfig = Readonly<{
  store: DeviceConnectionRouteStorePort;
  gatewayId: string;
  leaseDurationMs?: number;
  scheduler?: DeviceGatewayHeartbeatScheduler;
}>;

type SessionEntry = {
  session: DeviceGatewaySession;
  route: DeviceConnectionRoute | null;
  stopHeartbeat: () => void;
  renewing: boolean;
  removal: Promise<void> | null;
};

export class DeviceGateway {
  readonly #identityVerifier: DeviceIdentityVerifierPort;
  readonly #now: () => Date;
  readonly #authorizationVerifier: DeviceCommandAuthorizationVerifierPort;
  readonly #connectionRoutes: DeviceConnectionRouteStorePort | null;
  readonly #gatewayId: string | null;
  readonly #connectionLeaseMs: number;
  readonly #heartbeatScheduler: DeviceGatewayHeartbeatScheduler;
  readonly #sessions = new Map<string, SessionEntry>();
  #workspaceOrphanCommitter: WorkspaceSessionEventCommitter | null = null;

  constructor(
    identityVerifier: DeviceIdentityVerifierPort,
    options: Readonly<{
      now?: () => Date;
      authorizationVerifier: DeviceCommandAuthorizationVerifierPort;
      connectionRoutes?: DeviceGatewayConnectionRouteConfig;
    }>,
  ) {
    this.#identityVerifier = identityVerifier;
    this.#now = options.now ?? (() => new Date());
    this.#authorizationVerifier = options.authorizationVerifier;
    this.#connectionRoutes = options.connectionRoutes?.store ?? null;
    this.#gatewayId =
      options.connectionRoutes === undefined
        ? null
        : validateGatewayId(options.connectionRoutes.gatewayId);
    this.#connectionLeaseMs = requireLeaseDuration(
      options.connectionRoutes?.leaseDurationMs ?? DEFAULT_CONNECTION_LEASE_MS,
    );
    this.#heartbeatScheduler =
      options.connectionRoutes?.scheduler ?? systemHeartbeatScheduler;
  }

  async accept(
    socket: WebSocket,
    request: IncomingMessage,
  ): Promise<DeviceGatewaySession> {
    const identity = this.#identityVerifier.verify(request).catch((error) => {
      throw new DeviceGatewayError("device_authentication_failed", {
        cause: error,
      });
    });
    let session: DeviceGatewaySession;
    try {
      session = await DeviceGatewaySession.accept({
        socket,
        identity,
        now: this.#now,
        authorizationVerifier: this.#authorizationVerifier,
      });
    } catch (error) {
      if (socket.readyState === socket.OPEN) {
        socket.close(1008, "device_connection_rejected");
      }
      throw error;
    }
    let route: DeviceConnectionRoute | null = null;
    if (this.#connectionRoutes !== null) {
      try {
        route = await this.#connectionRoutes.claimConnection({
          deviceId: session.identity.deviceId,
          gatewayId: this.#gatewayId as string,
          connectionId: session.hello.connectionId,
          leaseDurationMs: this.#connectionLeaseMs,
        });
      } catch (error) {
        session.close();
        throw new DeviceGatewayError("device_connection_route_claim_failed", {
          cause: error,
        });
      }
    }
    if (session.isClosed()) {
      if (route !== null) {
        await this.#connectionRoutes?.releaseConnection(route);
      }
      throw new DeviceGatewayError("device_session_closed");
    }
    if (route !== null) {
      try {
        await session.establishConnectionEpoch({
          schemaVersion: "crewon.device-welcome.v0",
          protocolVersion: DEVICE_PROTOCOL_VERSION,
          deviceId: route.deviceId,
          connectionId: route.connectionId,
          gatewayId: route.gatewayId,
          connectionEpoch: route.epoch,
          leaseExpiresAt: route.leaseExpiresAt,
          sentAt: this.#now().toISOString(),
        });
      } catch (error) {
        await this.#connectionRoutes?.releaseConnection(route);
        session.close();
        throw new DeviceGatewayError("device_welcome_send_failed", {
          cause: error,
        });
      }
    }
    session.setWorkspaceOrphanEventCommitter(this.#workspaceOrphanCommitter);
    const existing = this.#sessions.get(session.identity.deviceId);
    if (existing !== undefined) {
      if (route === null) {
        socket.close(1008, "device_already_connected");
        throw new DeviceGatewayError("device_already_connected");
      }
      existing.session.close();
      await this.#remove(existing);
    }
    const entry: SessionEntry = {
      session,
      route,
      stopHeartbeat: () => undefined,
      renewing: false,
      removal: null,
    };
    this.#sessions.set(session.identity.deviceId, entry);
    socket.once("close", () => {
      void this.#remove(entry).catch(() => undefined);
    });
    this.#startHeartbeat(entry);
    return session;
  }

  session(deviceId: string): DeviceGatewaySession | null {
    return this.#sessions.get(validateDeviceId(deviceId))?.session ?? null;
  }

  workspaceSession(deviceId: string): Readonly<{
    session: DeviceGatewaySession;
    route: DeviceWorkspaceListPeerRoute;
  }> | null {
    const entry = this.#sessions.get(validateDeviceId(deviceId));
    if (entry === undefined || entry.route === null) return null;
    return {
      session: entry.session,
      route: {
        deviceId: entry.route.deviceId,
        gatewayId: entry.route.gatewayId,
        connectionId: entry.route.connectionId,
        connectionEpoch: entry.route.epoch,
        leaseExpiresAt: entry.route.leaseExpiresAt,
      },
    };
  }

  workspaceReadSession(
    deviceId: string,
    intent?: DeviceFilesystemReadRouteIntent,
  ) {
    const entry = this.#sessions.get(validateDeviceId(deviceId));
    if (entry === undefined || entry.route === null || intent === undefined)
      return null;
    return {
      session: entry.session,
      route: {
        deviceId: entry.route.deviceId,
        gatewayId: entry.route.gatewayId,
        connectionId: entry.route.connectionId,
        connectionEpoch: entry.route.epoch,
        deviceBindingId: intent.deviceBindingId,
        runtimeBindingId: intent.runtimeBindingId,
        capability: "workspace.read_file.v0" as const,
        leaseExpiresAt: entry.route.leaseExpiresAt,
      },
    };
  }

  setWorkspaceOrphanEventCommitter(
    committer: WorkspaceSessionEventCommitter | null,
  ): void {
    this.#workspaceOrphanCommitter = committer;
    for (const entry of this.#sessions.values()) {
      entry.session.setWorkspaceOrphanEventCommitter(committer);
    }
  }

  async close(): Promise<void> {
    const entries = [...this.#sessions.values()];
    for (const entry of entries) {
      entry.session.close();
    }
    await Promise.all(entries.map((entry) => this.#remove(entry)));
  }

  #startHeartbeat(entry: SessionEntry): void {
    if (entry.route === null || this.#connectionRoutes === null) {
      return;
    }
    entry.stopHeartbeat = this.#heartbeatScheduler.every(
      Math.max(1, Math.floor(this.#connectionLeaseMs / 3)),
      () => {
        void this.#renew(entry).catch(() => undefined);
      },
    );
  }

  async #renew(entry: SessionEntry): Promise<void> {
    if (
      entry.renewing ||
      entry.removal !== null ||
      entry.route === null ||
      this.#connectionRoutes === null
    ) {
      return;
    }
    entry.renewing = true;
    try {
      const renewed = await this.#connectionRoutes.renewConnection({
        ...entry.route,
        leaseDurationMs: this.#connectionLeaseMs,
      });
      if (renewed === null) {
        entry.session.close();
        await this.#remove(entry).catch(() => undefined);
        return;
      }
      entry.route = renewed;
    } catch {
      entry.session.close();
      await this.#remove(entry).catch(() => undefined);
    } finally {
      entry.renewing = false;
    }
  }

  #remove(entry: SessionEntry): Promise<void> {
    if (entry.removal !== null) {
      return entry.removal;
    }
    entry.removal = (async () => {
      entry.stopHeartbeat();
      if (this.#sessions.get(entry.session.identity.deviceId) === entry) {
        this.#sessions.delete(entry.session.identity.deviceId);
      }
      if (entry.route !== null) {
        await this.#connectionRoutes?.releaseConnection(entry.route);
      }
    })();
    return entry.removal;
  }
}

const systemHeartbeatScheduler: DeviceGatewayHeartbeatScheduler = {
  every(intervalMs, callback) {
    const timer = setInterval(callback, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  },
};
