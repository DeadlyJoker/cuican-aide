import type { AppsListResponse } from "@crewon-protocol/v2/AppsListResponse";

import { isMissingThreadError } from "../shared/rpcErrors";

type AppsClient = {
  listApps(threadId?: string): Promise<AppsListResponse>;
};

export async function listAppsForThreadOrGlobal(
  client: AppsClient | null | undefined,
  threadId: string | undefined,
): Promise<AppsListResponse | undefined> {
  if (!client) {
    return undefined;
  }

  try {
    return await client.listApps(threadId);
  } catch (error) {
    if (threadId && isMissingThreadError(error)) {
      return client.listApps();
    }
    throw error;
  }
}
