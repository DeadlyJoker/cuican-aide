import type { MediaInputOptionsResponse } from "@crewon/contracts/project-media-input-catalog";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ControlApiClientError,
  type ControlApiClient,
} from "@crewon/control-client";
import type { PublicProjectConversationBinding } from "@crewon/contracts/project-conversations";
import type { PublicProjectMediaInputStage } from "@crewon/contracts/project-media-input-stages";
import type { ProjectMediaInputStageComposerSelection } from "../control-runtime/controlProjectMediaInputStageTurn";
/** Original conversation stage: reviewed workflow/configuration and adopted script, with stale reads fenced. */
export function useProjectMediaInputStageComposer(
  input: Readonly<{
    client: ControlApiClient | null;
    binding: PublicProjectConversationBinding | null;
    briefRevision: number;
    episodeIds: readonly string[];
    active: boolean;
    threadRevision: number | null;
    refresh: number;
    retained: ProjectMediaInputStageComposerSelection | null;
  }>,
) {
  const [available, setAvailable] = useState(false),
    [loading, setLoading] = useState(false),
    [failure, setFailure] = useState(false),
    [workflowId, setWorkflowId] = useState<
      PublicProjectMediaInputStage["workflowId"]
    >("krea2-reference-four-view"),
    [episodeId, setEpisodeId] = useState("");
  const [configuration, setConfiguration] =
    useState<MediaInputOptionsResponse["configuration"]>(null);
  const [script, setScript] =
      useState<PublicProjectMediaInputStage["script"]>(null),
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
    setWorkflowId("krea2-reference-four-view");
    setEpisodeId("");
    setScript(null);
  }, [owner]);
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setAvailable(false);
    setConfiguration(null);
    setFailure(false);
    setLoading(input.client !== null && input.binding !== null);
    setSourceOwner(owner);
    if (input.client !== null && input.binding !== null)
      void input.client.projectMediaInputStages
        .getAvailability(input.binding.threadId, { signal: controller.signal })
        .then(async (result) => {
          if (!result.available || !alive || current.current !== owner) return;
          const options = await input.client!.projectMediaInputs.getOptions(
            { projectId: input.binding!.projectId },
            { signal: controller.signal },
          );
          if (!alive || current.current !== owner) return;
          setAvailable(true);
          setConfiguration(options.configuration);
          if (options.configuration !== null)
            setWorkflowId((previous) =>
              options.configuration!.workflows.includes(previous)
                ? previous
                : options.configuration!.workflows[0]!,
            );
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
    void input.client.projectTexts
      .getScript(input.binding.projectId, episodeId, {
        signal: controller.signal,
      })
      .then((result) => {
        const r = result.view?.selectedRevision;
        if (
          r?.kind !== "script" ||
          r.episodeId !== episodeId ||
          r.brief.briefRevision !== input.briefRevision ||
          result.view?.dependencyState !== "current"
        )
          throw new Error("project_media_input_script_unavailable");
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
    available &&
    configuration !== null;
  const selection: ProjectMediaInputStageComposerSelection | null =
    foreignRetained ||
    input.client === null ||
    input.binding === null ||
    input.binding.state !== "active" ||
    !input.active ||
    (retained === null && configuration === null)
      ? null
      : (retained ?? {
          binding: input.binding,
          stage: {
            kind: "media-input",
            configurationRevision: configuration!.revision,
            workflowId,
            briefRevision: input.briefRevision,
            script: scriptOwner === scriptSource ? script : null,
          },
        });
  return {
    available: actual,
    selection,
    workflows: configuration?.workflows ?? [],
    workflowId: retained?.stage.workflowId ?? workflowId,
    setWorkflowId,
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
            !configuration?.workflows.includes(workflowId) ||
            (workflowId === "flux2-three-reference-storyboard" &&
              episodeId === "") ||
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
