import { useEffect, useMemo, useRef, useState } from "react";
import type { ControlApiClient } from "@crewon/control-client";
import type { ControlPluginUiModule } from "./controlPluginUiCatalog";
import { subscribeProjectWorkspaceChanges } from "./projectWorkspaceChanges";

export function useInstalledPluginWorkspaceRevision(
  input: Readonly<{
    client: ControlApiClient | null;
    module: ControlPluginUiModule;
    projectId: string | null;
  }>,
) {
  const owner = useMemo(
    () => ({ ...input }),
    [input.client, input.module, input.projectId],
  );
  const [snapshot, setSnapshot] = useState({
    owner,
    foundation: 0,
    texts: 0,
    assets: 0,
  });
  const current = useRef(owner);
  current.current = owner;
  useEffect(() => {
    const { client, projectId } = owner;
    if (!client || !projectId) return;
    const subscriptions = (["foundation", "texts", "assets"] as const).map(
      (kind) =>
        subscribeProjectWorkspaceChanges(
          client,
          projectId,
          owner.module,
          kind,
          () => {
            if (current.current !== owner) return;
            setSnapshot((prior) => ({
              owner,
              foundation: prior.owner === owner ? prior.foundation : 0,
              texts: prior.owner === owner ? prior.texts : 0,
              assets: prior.owner === owner ? prior.assets : 0,
              [kind]: prior.owner === owner ? prior[kind] + 1 : 1,
            }));
          },
        ),
    );
    return () => subscriptions.forEach((unsubscribe) => unsubscribe());
  }, [owner]);
  return snapshot.owner === owner
    ? snapshot
    : { foundation: 0, texts: 0, assets: 0 };
}
