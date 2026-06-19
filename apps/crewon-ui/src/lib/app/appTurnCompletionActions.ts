import type { Turn } from "@crewon-protocol/v2/Turn";

import type { OfficeConfig } from "../domain/crewonDomain";
import {
  syncOfficeRun as syncBackendOfficeRun,
  type OfficeRunSyncClient,
} from "../domain/domainOfficeBackend";
import type { Locale } from "../i18n";
import type { OfficeRunTurnRecord } from "./appTurnCompletionNotificationHandler";

type ThreadTurnsClient = {
  listThreadTurns(threadId: string): Promise<Turn[]>;
};

export async function listThreadTurnsFromClientAction(
  client: ThreadTurnsClient | null | undefined,
  threadId: string,
): Promise<Turn[] | null> {
  return (await client?.listThreadTurns(threadId)) ?? null;
}

export async function syncOfficeRunFromClientAction(params: {
  client: OfficeRunSyncClient | null | undefined;
  config: OfficeConfig;
  locale: Locale;
  record: OfficeRunTurnRecord;
  turn: Turn;
}): Promise<OfficeConfig | null> {
  if (!params.client) {
    return null;
  }
  return syncBackendOfficeRun(
    params.client,
    params.record.cwd,
    params.config,
    params.turn,
    params.locale,
    params.record.runId,
  );
}
