import { useEffect, useRef, useState } from "react";
import { ControlApiClientError } from "@crewon/control-client";
import type {
  PluginCreditAccountsQuery,
  PluginCreditAccountsResponse,
  PluginCreditEntriesQuery,
  PluginCreditEntriesResponse,
} from "@crewon/contracts";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";

export interface PluginCreditClient {
  listAccounts(
    query?: Partial<PluginCreditAccountsQuery>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<PluginCreditAccountsResponse>;
  getEntries(
    query: Pick<PluginCreditEntriesQuery, "poolId"> &
      Partial<Omit<PluginCreditEntriesQuery, "poolId">>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<PluginCreditEntriesResponse>;
}
type Status =
  | "loading"
  | "ready"
  | "unconfigured"
  | "forbidden"
  | "unavailable"
  | "error"
  | "withdrawn";
type State = Readonly<{
  status: Status;
  accounts: PluginCreditAccountsResponse | null;
  accountsPage: number;
  selectedPoolId: string | null;
  entriesStatus: Status | "idle";
  entries: PluginCreditEntriesResponse | null;
  entriesPage: number;
}>;
type Owner = {
  client: PluginCreditClient;
  ownerKey: string;
  controller: AbortController;
  accountsRequest: AbortController | null;
  entriesRequest: AbortController | null;
  accounts: PluginCreditAccountsResponse | null;
  entries: PluginCreditEntriesResponse | null;
  selectedPoolId: string | null;
};
const EMPTY: State = Object.freeze({
  status: "loading",
  accounts: null,
  accountsPage: 1,
  selectedPoolId: null,
  entriesStatus: "idle",
  entries: null,
  entriesPage: 1,
});
const REQUEST_TIMEOUT_MS = 15_000;

/** Read only one visible page. The authenticated server owns account scope and every balance. */
export function usePluginCreditAccounts({
  client,
  ownerKey,
}: Readonly<{ client: PluginCreditClient; ownerKey: string }>) {
  const [state, setState] = useState<State>(EMPTY);
  const owner = useRef<Owner | null>(null);
  const requested = useRef({ client, ownerKey });
  requested.current = { client, ownerKey };
  const alive = (current: Owner) =>
    owner.current === current &&
    requested.current.client === current.client &&
    requested.current.ownerKey === current.ownerKey &&
    !current.controller.signal.aborted;
  const signal = (current: Owner, request: AbortController) =>
    AbortSignal.any([
      current.controller.signal,
      request.signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ]);

  const loadAccounts = async (
    current: Owner,
    afterPoolId: string | null,
    page: number,
  ) => {
    if (!alive(current)) return;
    current.accountsRequest?.abort();
    current.entriesRequest?.abort();
    const request = new AbortController();
    current.accountsRequest = request;
    current.entriesRequest = null;
    current.accounts = null;
    current.entries = null;
    current.selectedPoolId = null;
    setState({ ...EMPTY, accountsPage: page });
    try {
      const result = await current.client.listAccounts(
        { afterPoolId, limit: 16 },
        { signal: signal(current, request) },
      );
      if (!alive(current) || request.signal.aborted) return;
      current.accounts = result;
      setState({
        ...EMPTY,
        status: result.state,
        accounts: result,
        accountsPage: page,
      });
    } catch (cause) {
      if (alive(current) && !request.signal.aborted)
        setState({
          ...EMPTY,
          status: failureStatus(cause),
          accountsPage: page,
        });
    }
  };

  const loadEntries = async (
    current: Owner,
    poolId: string,
    afterRevision: number,
    page: number,
  ) => {
    if (
      !alive(current) ||
      !current.accounts?.accounts.some((account) => account.poolId === poolId)
    )
      return;
    current.entriesRequest?.abort();
    const request = new AbortController();
    current.entriesRequest = request;
    current.selectedPoolId = poolId;
    current.entries = null;
    setState((previous) => ({
      ...previous,
      selectedPoolId: poolId,
      entriesStatus: "loading",
      entries: null,
      entriesPage: page,
    }));
    try {
      const result = await current.client.getEntries(
        { poolId, afterRevision, limit: 50 },
        { signal: signal(current, request) },
      );
      if (
        !alive(current) ||
        request.signal.aborted ||
        current.selectedPoolId !== poolId
      )
        return;
      // Typed transport verifies the protocol. This guard binds that response to
      // the chosen account rather than displaying another pool's current balance.
      if (result.account !== null && result.account.poolId !== poolId)
        throw new Error("plugin_credit_account_response_mismatch");
      current.entries = result;
      setState((previous) => ({
        ...previous,
        entriesStatus: result.state,
        entries: result,
      }));
    } catch (cause) {
      if (alive(current) && !request.signal.aborted)
        setState((previous) => ({
          ...previous,
          entriesStatus: failureStatus(cause),
          entries: null,
        }));
    }
  };

  useEffect(() => {
    const current: Owner = {
      client,
      ownerKey,
      controller: new AbortController(),
      accountsRequest: null,
      entriesRequest: null,
      accounts: null,
      entries: null,
      selectedPoolId: null,
    };
    owner.current = current;
    const withdraw = () => {
      current.controller.abort();
      current.accounts = null;
      current.entries = null;
      current.selectedPoolId = null;
      setState({ ...EMPTY, status: "withdrawn" });
    };
    window.addEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, withdraw);
    void loadAccounts(current, null, 1);
    return () => {
      current.controller.abort();
      current.accountsRequest?.abort();
      current.entriesRequest?.abort();
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        withdraw,
      );
    };
  }, [client, ownerKey]);

  const current = owner.current;
  const visible =
    current?.client === client && current.ownerKey === ownerKey ? state : EMPTY;
  return {
    ...visible,
    available: current !== null && alive(current),
    refresh: () => {
      if (current) void loadAccounts(current, null, 1);
    },
    firstAccounts: () => {
      if (current) void loadAccounts(current, null, 1);
    },
    nextAccounts: () => {
      if (current?.accounts?.nextPoolId)
        void loadAccounts(
          current,
          current.accounts.nextPoolId,
          visible.accountsPage + 1,
        );
    },
    selectPool: (poolId: string) => {
      if (current && poolId !== current.selectedPoolId)
        void loadEntries(current, poolId, 0, 1);
    },
    firstEntries: () => {
      if (current?.selectedPoolId)
        void loadEntries(current, current.selectedPoolId, 0, 1);
    },
    nextEntries: () => {
      const after = current?.entries?.nextRevision;
      if (current?.selectedPoolId && after !== null && after !== undefined)
        void loadEntries(
          current,
          current.selectedPoolId,
          after,
          visible.entriesPage + 1,
        );
    },
  };
}

function failureStatus(cause: unknown): "forbidden" | "unavailable" | "error" {
  if (cause instanceof ControlApiClientError) {
    if (cause.status === 401 || cause.status === 403) return "forbidden";
    if (cause.status === 404 || cause.status === 503) return "unavailable";
  }
  return "error";
}
