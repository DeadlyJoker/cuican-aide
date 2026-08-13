import { useMemo } from "react";
import type { ControlApiClient } from "@crewon/control-client";

import type { Locale } from "../../lib/i18n";
import {
  createControlOffice,
  controlOfficeVersionId,
  listControlOfficeCatalog,
} from "../../lib/office/controlOfficeRuntime";
import { ControlOfficeRoom } from "./ControlOfficeRoom";
import type { CommandOfficeRoomAdapter } from "./CommandWorkspace";

export function createControlCommandOfficeRoomAdapter({
  client,
  locale,
  threadId,
}: {
  client: ControlApiClient;
  locale: Locale;
  threadId: string | null;
}): CommandOfficeRoomAdapter {
  return {
    listCatalog: async () => {
      const catalog = await listControlOfficeCatalog(client);
      return { ...catalog, officeStatus: "ready", status: "ready" };
    },
    create: (input) =>
      createControlOffice({
        client,
        locale,
        members: input.members,
        title: input.title,
      }),
    open: async (record) => {
      const officeVersionId = controlOfficeVersionId(record);
      if (!officeVersionId) {
        throw new Error(
          locale === "zh"
            ? "缺少 Control officeVersionId"
            : "Missing Control officeVersionId",
        );
      }
      await client.getOffice(officeVersionId);
    },
    render: (record, onBack) => {
      const officeVersionId = controlOfficeVersionId(record);
      return officeVersionId ? (
        <ControlOfficeRoom
          client={client}
          locale={locale}
          officeVersionId={officeVersionId}
          onBack={onBack}
          threadId={threadId}
        />
      ) : (
        <div className="team-office-room-error" role="alert">
          {locale === "zh"
            ? "缺少 Control officeVersionId"
            : "Missing Control officeVersionId"}
        </div>
      );
    },
  };
}

export function useControlCommandOfficeRoomAdapter(params: {
  client: ControlApiClient;
  locale: Locale;
  threadId: string | null;
}) {
  return useMemo(
    () => createControlCommandOfficeRoomAdapter(params),
    [params.client, params.locale, params.threadId],
  );
}
