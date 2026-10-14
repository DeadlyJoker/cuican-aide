import { useEffect, useMemo, useRef, useState } from "react";
import {
  ControlApiClientError,
  type ControlApiClient,
} from "@crewon/control-client";
import type { PublicProjectConversationBinding } from "@crewon/contracts/project-conversations";
import type { PublicProjectAssetStage } from "@crewon/contracts/project-asset-stages";
import type { ProjectAssetStageComposerSelection } from "../control-runtime/controlProjectAssetStageTurn";
/** Reads independent approval and an explicitly selected script. Ordinary chat is unaffected by absent asset approval. */
export function useProjectAssetStageComposer(
  input: Readonly<{
    client: ControlApiClient | null;
    binding: PublicProjectConversationBinding | null;
    briefRevision: number;
    episodeIds: readonly string[];
    active: boolean;
    preferredAssetKind?: PublicProjectAssetStage["assetKind"];
    threadRevision: number | null;
    refresh: number;
    retained: ProjectAssetStageComposerSelection | null;
  }>,
) {
  const [available, setAvailable] = useState(false),
    [loading, setLoading] = useState(false),
    [failure, setFailure] = useState(false),
    [assetKind, setAssetKind] =
      useState<PublicProjectAssetStage["assetKind"]>("character"),
    [episodeId, setEpisodeId] = useState("");
  const [script, setScript] = useState<PublicProjectAssetStage["script"]>(null),
    [scriptLoading, setScriptLoading] = useState(false),
    [scriptFailure, setScriptFailure] = useState(false);
  const bindingKey = JSON.stringify(input.binding);
  const owner = useMemo(
    () => ({ client: input.client, bindingKey }),
    [input.client, bindingKey],
  );
  const retained =
    input.binding !== null &&
    sameBindingOwner(input.binding, input.retained?.binding)
      ? input.retained
      : null;
  const foreignRetained = input.retained !== null && retained === null;
  const episodeKey = JSON.stringify(input.episodeIds);
  const scriptSource = useMemo(
    () => ({
      owner,
      episodeId,
      briefRevision: input.briefRevision,
      episodeKey,
    }),
    [owner, episodeId, input.briefRevision, episodeKey],
  );
  const current = useRef(owner);
  current.current = owner;
  const currentScript = useRef(scriptSource);
  currentScript.current = scriptSource;
  const [sourceOwner, setSourceOwner] = useState(owner),
    [scriptOwner, setScriptOwner] = useState(scriptSource);
  useEffect(() => {
    setAssetKind("character");
    setEpisodeId("");
    setScript(null);
  }, [owner]);
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setAvailable(false);
    setFailure(false);
    setLoading(input.client !== null && input.binding !== null);
    setSourceOwner(owner);
    if (input.client !== null && input.binding !== null)
      void input.client.projectAssetStages
        .getAvailability(input.binding.threadId, { signal: controller.signal })
        .then((result) => {
          if (alive && current.current === owner)
            setAvailable(result.available);
        })
        .catch((error) => {
          if (!alive || current.current !== owner) return;
          if (
            error instanceof ControlApiClientError &&
            error.status === 404 &&
            error.code === "route_not_found"
          )
            return;
          setFailure(true);
        })
        .finally(() => {
          if (alive && current.current === owner) setLoading(false);
        });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [input.client, owner, input.threadRevision, input.refresh]);
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setScript(null);
    setScriptFailure(false);
    setScriptLoading(false);
    setScriptOwner(scriptSource);
    if (
      !input.active ||
      input.client === null ||
      input.binding === null ||
      episodeId === "" ||
      retained !== null
    )
      return () => controller.abort();
    if (!input.episodeIds.includes(episodeId)) {
      setScriptFailure(true);
      return () => controller.abort();
    }
    setScriptLoading(true);
    void input.client.projectAssetStages
      .getScriptSource(
        {
          projectId: input.binding.projectId,
          threadId: input.binding.threadId,
          expectedBindingRevision: input.binding.revision,
          briefRevision: input.briefRevision,
          episodeId,
        },
        { signal: controller.signal },
      )
      .then((result) => {
        const r = result.script;
        if (r === null) throw new Error("project_asset_script_unavailable");
        if (alive && currentScript.current === scriptSource)
          setScript({
            artifactId: r.artifactId,
            episodeId: r.episodeId,
            contentRevision: r.contentRevision,
          });
      })
      .catch(() => {
        if (alive && currentScript.current === scriptSource)
          setScriptFailure(true);
      })
      .finally(() => {
        if (alive && currentScript.current === scriptSource)
          setScriptLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [
    input.client,
    owner,
    input.active,
    episodeId,
    input.briefRevision,
    input.threadRevision,
    input.refresh,
    input.retained,
    scriptSource,
  ]);
  const actual =
    input.client !== null &&
    input.binding?.state === "active" &&
    sourceOwner === owner &&
    available;
  const selectedAssetKind =
    input.preferredAssetKind === "scene" && assetKind === "prop"
      ? "prop"
      : (input.preferredAssetKind ?? assetKind);
  const selection: ProjectAssetStageComposerSelection | null =
    foreignRetained ||
    input.client === null ||
    input.binding === null ||
    input.binding.state !== "active" ||
    !input.active
      ? null
      : (retained ?? {
          binding: input.binding,
          stage: {
            kind: "assets",
            assetKind: selectedAssetKind,
            briefRevision: input.briefRevision,
            script: scriptOwner === scriptSource ? script : null,
          },
        });
  return {
    available: actual,
    selection,
    assetKind: retained?.stage.assetKind ?? selectedAssetKind,
    setAssetKind,
    episodeId: retained?.stage.script?.episodeId ?? episodeId,
    setEpisodeId,
    blocked:
      input.active &&
      (input.client === null ||
        foreignRetained ||
        input.binding === null ||
        input.binding.state !== "active" ||
        sourceOwner !== owner ||
        !actual ||
        loading ||
        failure ||
        input.briefRevision < 1 ||
        (retained === null &&
          (scriptOwner !== scriptSource ||
            scriptLoading ||
            scriptFailure ||
            (episodeId !== "" && script === null)))),
  };
}
function sameBindingOwner(
  binding: PublicProjectConversationBinding,
  retained: PublicProjectConversationBinding | undefined,
): boolean {
  return (
    retained !== undefined &&
    binding.bindingId === retained.bindingId &&
    binding.projectId === retained.projectId &&
    binding.threadId === retained.threadId &&
    binding.workspaceId === retained.workspaceId &&
    JSON.stringify(binding.source) === JSON.stringify(retained.source)
  );
}
