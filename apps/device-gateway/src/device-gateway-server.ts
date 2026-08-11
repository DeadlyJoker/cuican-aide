import {
  createServer,
  type Server as HttpsServer,
  type ServerOptions,
} from "node:https";
import type { AddressInfo } from "node:net";

import { WebSocketServer } from "ws";

import { DeviceGateway } from "./device-gateway.ts";
import type { DeviceGatewayConnectionRouteConfig } from "./device-gateway.ts";
import {
  DeviceGatewayDispatchRouter,
  type DeviceGatewayPeerDispatchPort,
} from "./device-gateway-dispatch-router.ts";
import type { DeviceCommandAuthorizationVerifierPort } from "./device-command-authorization-verifier.ts";
import { DeviceGatewayDispatchService } from "./device-gateway-dispatch-service.ts";
import { DeviceGatewayWorkspaceDispatchService } from "./device-gateway-workspace-dispatch-service.ts";
import {
  DeviceGatewayWorkspaceDispatchRouter,
  type DeviceGatewayWorkspacePeerDispatchPort,
} from "./device-gateway-workspace-dispatch-router.ts";
import { DeviceGatewayWorkspacePeerApi } from "./device-gateway-workspace-peer-api.ts";
import { DeviceGatewayWorkspaceWorkerApi } from "./device-gateway-workspace-worker-api.ts";
import type { DeviceDispatchStorePort } from "./device-dispatch-store.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import { DeviceGatewayPeerApi } from "./device-gateway-peer-api.ts";
import { DeviceGatewayWorkerApi } from "./device-gateway-worker-api.ts";
import type { DeviceIdentityVerifierPort } from "./device-identity.ts";
import type { GatewayIdentityVerifierPort } from "./gateway-identity.ts";
import type { WorkerIdentityVerifierPort } from "./worker-identity.ts";
import type { WorkspaceCommandAuthorizationVerifierPort } from "./workspace-command-authorization-verifier.ts";
import type { WorkspaceDispatchStorePort } from "./workspace-dispatch-store.ts";
import type { WorkspaceWorkerRuntimeAuthorizerPort } from "./workspace-worker-runtime-authorizer.ts";

const DEVICE_PATH = "/device/v1";

export type DeviceGatewayServerAddress = Readonly<{
  host: string;
  port: number;
  path: typeof DEVICE_PATH;
}>;

export class DeviceGatewayServer {
  readonly #gateway: DeviceGateway;
  readonly #dispatch: DeviceGatewayDispatchService;
  readonly #dispatchStore: DeviceDispatchStorePort;
  readonly #workerApi: DeviceGatewayWorkerApi;
  readonly #workspaceDispatch: DeviceGatewayWorkspaceDispatchService | null;
  readonly #workspaceStore: WorkspaceDispatchStorePort | null;
  readonly #workspaceWorkerApi: DeviceGatewayWorkspaceWorkerApi | null;
  readonly #workspacePeerApi: DeviceGatewayWorkspacePeerApi | null;
  readonly #workspacePeerDispatch: DeviceGatewayWorkspacePeerDispatchPort | null;
  readonly #peerApi: DeviceGatewayPeerApi | null;
  readonly #peerDispatch: DeviceGatewayPeerDispatchPort | null;
  readonly #server: HttpsServer;
  readonly #webSocketServer: WebSocketServer;
  #listening = false;
  #closed = false;

  constructor(config: {
    tls: ServerOptions;
    identityVerifier: DeviceIdentityVerifierPort;
    workerIdentityVerifier: WorkerIdentityVerifierPort;
    authorizationVerifier: DeviceCommandAuthorizationVerifierPort;
    dispatchStore: DeviceDispatchStorePort;
    workspaceDispatchStore?: WorkspaceDispatchStorePort;
    workspaceAuthorizationVerifier?: WorkspaceCommandAuthorizationVerifierPort;
    workspaceWorkerAuthorizer?: WorkspaceWorkerRuntimeAuthorizerPort;
    workspacePeerDispatch?: DeviceGatewayWorkspacePeerDispatchPort;
    workspaceRouteTopology?: "standalone" | "team";
    connectionRoutes?: DeviceGatewayConnectionRouteConfig;
    peerDispatch?: DeviceGatewayPeerDispatchPort;
    gatewayIdentityVerifier?: GatewayIdentityVerifierPort;
    now?: () => Date;
  }) {
    this.#gateway = new DeviceGateway(config.identityVerifier, {
      now: config.now,
      authorizationVerifier: config.authorizationVerifier,
      connectionRoutes: config.connectionRoutes,
    });
    this.#dispatchStore = config.dispatchStore;
    this.#dispatch = new DeviceGatewayDispatchService({
      sessions: this.#gateway,
      authorizationVerifier: config.authorizationVerifier,
      store: this.#dispatchStore,
      now: config.now,
    });
    if (
      config.gatewayIdentityVerifier !== undefined &&
      config.connectionRoutes === undefined
    ) {
      throw new DeviceGatewayError("device_gateway_peer_config_invalid");
    }
    const router =
      config.connectionRoutes === undefined
        ? null
        : new DeviceGatewayDispatchRouter({
            gatewayId: config.connectionRoutes.gatewayId,
            routes: config.connectionRoutes.store,
            sessions: this.#gateway,
            local: this.#dispatch,
            peers: config.peerDispatch ?? unavailablePeerDispatch,
          });
    const workerDispatch = router ?? this.#dispatch;
    this.#workerApi = new DeviceGatewayWorkerApi({
      identityVerifier: config.workerIdentityVerifier,
      dispatch: workerDispatch,
    });
    const workspaceParts = [
      config.workspaceDispatchStore,
      config.workspaceAuthorizationVerifier,
      config.workspaceWorkerAuthorizer,
    ].filter((value) => value !== undefined).length;
    if (workspaceParts !== 0 && workspaceParts !== 3) {
      throw new DeviceGatewayError("workspace_dispatch_config_invalid");
    }
    this.#workspaceStore = config.workspaceDispatchStore ?? null;
    this.#workspaceDispatch =
      this.#workspaceStore === null
        ? null
        : new DeviceGatewayWorkspaceDispatchService({
            sessions: this.#gateway,
            authorizationVerifier:
              config.workspaceAuthorizationVerifier as WorkspaceCommandAuthorizationVerifierPort,
            workerAuthorizer:
              config.workspaceWorkerAuthorizer as WorkspaceWorkerRuntimeAuthorizerPort,
            store: this.#workspaceStore,
            now: config.now,
          });
    const workspaceRouteConfigured =
      this.#workspaceDispatch !== null && config.connectionRoutes !== undefined;
    const workspaceRouteTopology = config.workspaceRouteTopology ?? "team";
    if (
      (config.workspaceRouteTopology !== undefined &&
        !workspaceRouteConfigured) ||
      (workspaceRouteConfigured &&
        workspaceRouteTopology === "team" &&
        (config.workspacePeerDispatch === undefined ||
          config.gatewayIdentityVerifier === undefined)) ||
      (workspaceRouteTopology === "standalone" &&
        (config.workspacePeerDispatch !== undefined ||
          config.gatewayIdentityVerifier !== undefined)) ||
      (!workspaceRouteConfigured && config.workspacePeerDispatch !== undefined)
    ) {
      throw new DeviceGatewayError("workspace_peer_config_invalid");
    }
    const workspaceRouter =
      this.#workspaceDispatch === null ||
      config.connectionRoutes === undefined ||
      workspaceRouteTopology === "standalone"
        ? null
        : new DeviceGatewayWorkspaceDispatchRouter({
            gatewayId: config.connectionRoutes.gatewayId,
            routes: config.connectionRoutes.store,
            local: this.#workspaceDispatch,
            peers:
              config.workspacePeerDispatch ?? unavailableWorkspacePeerDispatch,
          });
    this.#workspaceWorkerApi =
      this.#workspaceDispatch === null
        ? null
        : new DeviceGatewayWorkspaceWorkerApi({
            identityVerifier: config.workerIdentityVerifier,
            dispatch: workspaceRouter ?? this.#workspaceDispatch,
          });
    this.#workspacePeerApi =
      workspaceRouter === null || config.gatewayIdentityVerifier === undefined
        ? null
        : new DeviceGatewayWorkspacePeerApi({
            gatewayId: config.connectionRoutes!.gatewayId,
            identityVerifier: config.gatewayIdentityVerifier,
            routes: config.connectionRoutes!.store,
            workerAuthorizer:
              config.workspaceWorkerAuthorizer as WorkspaceWorkerRuntimeAuthorizerPort,
            dispatch: this.#workspaceDispatch!,
          });
    this.#workspacePeerDispatch = config.workspacePeerDispatch ?? null;
    this.#peerApi =
      router === null || config.gatewayIdentityVerifier === undefined
        ? null
        : new DeviceGatewayPeerApi({
            identityVerifier: config.gatewayIdentityVerifier,
            dispatch: router,
          });
    this.#peerDispatch = config.peerDispatch ?? null;
    this.#server = createServer(
      {
        ...config.tls,
        minVersion: "TLSv1.3",
        requestCert: true,
        rejectUnauthorized: true,
      },
      (request, response) => {
        void this.#workerApi
          .handle(request, response)
          .then((handled) =>
            handled || this.#workspaceWorkerApi === null
              ? handled
              : this.#workspaceWorkerApi.handle(request, response),
          )
          .then((handled) =>
            handled || this.#peerApi === null
              ? handled
              : this.#peerApi.handle(request, response),
          )
          .then((handled) =>
            handled || this.#workspacePeerApi === null
              ? handled
              : this.#workspacePeerApi.handle(request, response),
          )
          .then((handled) => {
            if (!handled && !response.headersSent) {
              response.writeHead(404, {
                "cache-control": "no-store",
                "content-type": "text/plain; charset=utf-8",
              });
              response.end("Not Found\n");
            }
          })
          .catch(() => {
            if (!response.headersSent) {
              response.writeHead(500, {
                "cache-control": "no-store",
                "content-type": "text/plain; charset=utf-8",
              });
              response.end("Internal Server Error\n");
            } else {
              response.destroy();
            }
          });
      },
    );
    this.#webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: 128 * 1024,
      perMessageDeflate: false,
      clientTracking: true,
    });
    this.#server.on("upgrade", (request, socket, head) => {
      if (request.url !== DEVICE_PATH) {
        socket.write(
          "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
        socket.destroy();
        return;
      }
      this.#webSocketServer.handleUpgrade(
        request,
        socket,
        head,
        (webSocket) => {
          this.#webSocketServer.emit("connection", webSocket, request);
        },
      );
    });
    this.#webSocketServer.on("connection", (socket, request) => {
      void this.#gateway.accept(socket, request).catch(() => {
        if (socket.readyState === socket.OPEN) {
          socket.close(1008, "device_connection_rejected");
        }
      });
    });
  }

  async listen(
    host: string,
    port: number,
  ): Promise<DeviceGatewayServerAddress> {
    if (this.#closed || this.#listening) {
      throw new Error("device_gateway_server_state_invalid");
    }
    validateListenAddress(host, port);
    await Promise.all([
      this.#dispatchStore.ready(),
      this.#workspaceStore?.ready(),
    ]);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.#server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.#server.off("error", onError);
        resolve();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(port, host);
    });
    this.#listening = true;
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("device_gateway_address_invalid");
    }
    return addressProjection(address);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const dispatchClosed = this.#dispatch.close();
    const workspaceDispatchClosed = this.#workspaceDispatch?.close();
    const gatewayClosed = this.#gateway.close();
    for (const client of this.#webSocketServer.clients) {
      client.terminate();
    }
    const webSocketClosed = new Promise<void>((resolve) => {
      this.#webSocketServer.close(() => resolve());
    });
    const serverClosed = new Promise<void>((resolve, reject) => {
      if (!this.#listening) {
        resolve();
        return;
      }
      this.#server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
    const shutdown = await Promise.allSettled([
      dispatchClosed,
      workspaceDispatchClosed,
      gatewayClosed,
      webSocketClosed,
      serverClosed,
    ]);
    const storeClosed = await Promise.allSettled([
      this.#dispatchStore.close(),
      this.#workspaceStore?.close(),
    ]);
    const peerClosed = await Promise.allSettled([
      Promise.resolve(this.#peerDispatch?.close?.()),
      Promise.resolve(this.#workspacePeerDispatch?.close?.()),
    ]);
    this.#listening = false;
    const failure = [...shutdown, ...storeClosed, ...peerClosed].find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) {
      throw failure.reason;
    }
  }
}

const unavailablePeerDispatch: DeviceGatewayPeerDispatchPort = {
  async dispatch() {
    throw new DeviceGatewayError("device_gateway_peer_unavailable");
  },
};

const unavailableWorkspacePeerDispatch: DeviceGatewayWorkspacePeerDispatchPort =
  {
    async dispatch() {
      throw new DeviceGatewayError("workspace_dispatch_route_unavailable");
    },
  };

function validateListenAddress(host: string, port: number): void {
  if (
    host.trim().length === 0 ||
    /[\r\n]/.test(host) ||
    !Number.isSafeInteger(port) ||
    port < 0 ||
    port > 65_535
  ) {
    throw new Error("device_gateway_listen_address_invalid");
  }
}

function addressProjection(address: AddressInfo): DeviceGatewayServerAddress {
  return {
    host: address.address,
    port: address.port,
    path: DEVICE_PATH,
  };
}
