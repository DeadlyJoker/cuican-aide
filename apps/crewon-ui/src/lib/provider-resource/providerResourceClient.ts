import type { ProviderConnectParams } from "@crewon-platform-model/v2/ProviderConnectParams";
import type { ProviderConnectResponse } from "@crewon-platform-model/v2/ProviderConnectResponse";
import type { ProviderReadParams } from "@crewon-platform-model/v2/ProviderReadParams";
import type { ProviderReadResponse } from "@crewon-platform-model/v2/ProviderReadResponse";
import type { ResourceBindParams } from "@crewon-platform-model/v2/ResourceBindParams";
import type { ResourceBindResponse } from "@crewon-platform-model/v2/ResourceBindResponse";
import type { ResourceListParams } from "@crewon-platform-model/v2/ResourceListParams";
import type { ResourceListResponse } from "@crewon-platform-model/v2/ResourceListResponse";
import type { ResourceReadParams } from "@crewon-platform-model/v2/ResourceReadParams";
import type { ResourceReadResponse } from "@crewon-platform-model/v2/ResourceReadResponse";
import type { ResourceUnbindParams } from "@crewon-platform-model/v2/ResourceUnbindParams";
import type { ResourceUnbindResponse } from "@crewon-platform-model/v2/ResourceUnbindResponse";
import type { WorkspaceBindParams } from "@crewon-platform-model/v2/WorkspaceBindParams";
import type { WorkspaceBindResponse } from "@crewon-platform-model/v2/WorkspaceBindResponse";
import type { WorkspaceListParams } from "@crewon-platform-model/v2/WorkspaceListParams";
import type { WorkspaceListResponse } from "@crewon-platform-model/v2/WorkspaceListResponse";
import type { ThreadExecutionContextUpdateParams } from "@crewon-platform-model/v2/ThreadExecutionContextUpdateParams";
import type { ThreadExecutionContextUpdateResponse } from "@crewon-platform-model/v2/ThreadExecutionContextUpdateResponse";

export type ProviderResourceRpc = {
  "workspace/list": {
    params: WorkspaceListParams;
    response: WorkspaceListResponse;
  };
  "workspace/bind": {
    params: WorkspaceBindParams;
    response: WorkspaceBindResponse;
  };
  "provider/connect": {
    params: ProviderConnectParams;
    response: ProviderConnectResponse;
  };
  "provider/read": {
    params: ProviderReadParams;
    response: ProviderReadResponse;
  };
  "resource/list": {
    params: ResourceListParams;
    response: ResourceListResponse;
  };
  "resource/read": {
    params: ResourceReadParams;
    response: ResourceReadResponse;
  };
  "resource/bind": {
    params: ResourceBindParams;
    response: ResourceBindResponse;
  };
  "resource/unbind": {
    params: ResourceUnbindParams;
    response: ResourceUnbindResponse;
  };
  "threadExecutionContext/update": {
    params: ThreadExecutionContextUpdateParams;
    response: ThreadExecutionContextUpdateResponse;
  };
};

export type ProviderResourceRpcMethod = keyof ProviderResourceRpc;

export type ProviderResourceRpcTransport = {
  request<Method extends ProviderResourceRpcMethod>(
    method: Method,
    params: ProviderResourceRpc[Method]["params"],
  ): Promise<ProviderResourceRpc[Method]["response"]>;
};

export class ProviderResourceClient {
  constructor(private readonly transport: ProviderResourceRpcTransport) {}

  listWorkspaces(params: WorkspaceListParams): Promise<WorkspaceListResponse> {
    return this.transport.request("workspace/list", params);
  }

  bindWorkspace(params: WorkspaceBindParams): Promise<WorkspaceBindResponse> {
    return this.transport.request("workspace/bind", params);
  }

  connectProvider(
    params: ProviderConnectParams,
  ): Promise<ProviderConnectResponse> {
    return this.transport.request("provider/connect", params);
  }

  readProvider(params: ProviderReadParams): Promise<ProviderReadResponse> {
    return this.transport.request("provider/read", params);
  }

  listResources(params: ResourceListParams): Promise<ResourceListResponse> {
    return this.transport.request("resource/list", params);
  }

  readResource(params: ResourceReadParams): Promise<ResourceReadResponse> {
    return this.transport.request("resource/read", params);
  }

  bindResource(params: ResourceBindParams): Promise<ResourceBindResponse> {
    return this.transport.request("resource/bind", params);
  }

  unbindResource(
    params: ResourceUnbindParams,
  ): Promise<ResourceUnbindResponse> {
    return this.transport.request("resource/unbind", params);
  }

  updateThreadExecutionContext(
    params: ThreadExecutionContextUpdateParams,
  ): Promise<ThreadExecutionContextUpdateResponse> {
    return this.transport.request("threadExecutionContext/update", params);
  }
}
