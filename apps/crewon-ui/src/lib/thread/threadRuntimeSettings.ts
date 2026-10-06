import type { ProjectMediaInputStageComposerSelection } from "../control-runtime/controlProjectMediaInputStageTurn";
import type { ProjectAssetStageComposerSelection } from "../control-runtime/controlProjectAssetStageTurn";
import type { ProjectConversationComposerSelection } from "../control-runtime/controlProjectConversationTurn";
import type { AskForApproval } from "@crewon/app-server-protocol/v2/AskForApproval";
import type { ApprovalsReviewer } from "@crewon/app-server-protocol/v2/ApprovalsReviewer";
import type { Model } from "@crewon/app-server-protocol/v2/Model";
import type { SandboxMode } from "@crewon/app-server-protocol/v2/SandboxMode";

import type { PersonalizationSettings } from "../settings/personalizationSettingsStore";

export type RuntimeDynamicTool = {
  namespace: string;
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading: boolean;
};

export type CommandComposerPermission =
  | "approve-for-me"
  | "full-access"
  | "request-approval";

export type CommandExecutionIntent = "goal" | "none" | "plan";

export type CommandModelReasoningEffort = {
  description?: string;
  value: string;
};

export type CommandModelOption = {
  defaultReasoningEffort?: string;
  detail?: string;
  isDefault?: boolean;
  label: string;
  /**
   * Efforts the backend catalog reports for this model, in catalog order. Empty
   * or absent when the model exposes no effort choice.
   */
  reasoningEfforts?: CommandModelReasoningEffort[];
  value: string;
};

export type ThreadRuntimeSettings = {
  projectConversation?: ProjectConversationComposerSelection;
  projectAssetStage?:ProjectAssetStageComposerSelection;
  projectMediaInputStage?: ProjectMediaInputStageComposerSelection;
  approvalPolicy?: AskForApproval | null;
  approvalsReviewer?: ApprovalsReviewer | null;
  config?: Record<string, unknown>;
  model?: string | null;
  personalization?: PersonalizationSettings;
  reasoningEffort?: string | null;
  sandboxMode?: SandboxMode | null;
  scene?: ThreadSceneSelection;
  executionIntent?: CommandExecutionIntent;
  dynamicTools?: RuntimeDynamicTool[];
  teamMemberProfiles?: TeamMemberRuntimeProfile[];
  /**
   * When set inside a Team scene, the turn is routed directly to this Office
   * member instead of running full Team orchestration. Only one member is
   * eligible per turn; the runtime validates the ID against the live Office
   * definition before dispatching.
   */
  teamTargetMemberId?: string;
  threadSource?: string;
};

export type TeamMemberRuntimeCapability = Readonly<{
  name: string;
  description: string;
}>;

export type TeamMemberRuntimeProfile = Readonly<{
  memberId: string;
  systemPrompt: string;
  skills: readonly TeamMemberRuntimeCapability[];
  mcp: readonly TeamMemberRuntimeCapability[];
  knowledge: readonly TeamMemberRuntimeCapability[];
  teamCoordination?: Readonly<{
    assignmentMode: "roleDirected";
    responsibility: string;
    source: "officeDefinition";
  }>;
}>;

export type ThreadSceneSelection = {
  sceneId: "office" | "code" | "design";
  mode?:
    | "auto"
    | "organize"
    | "write"
    | "analyze"
    | "coordinate"
    | "ask"
    | "plan"
    | "implement"
    | "review"
    | "explore"
    | "refine"
    | "produce"
    | "inspect";
  executionTarget:
    | { kind: "crewon" }
    | { kind: "agent"; id: string }
    | { kind: "team"; id: string }
    | { kind: "experts"; id: string };
};

export const fallbackCommandModelOptions: CommandModelOption[] = [
  { label: "gpt-5-mini", value: "gpt-5-mini" },
  { label: "gpt-5.6-sol", value: "gpt-5.6-sol" },
  { label: "gpt-5.6", value: "gpt-5.6" },
  { label: "gpt-5.5", value: "gpt-5.5" },
  { label: "gpt-5-codex", value: "gpt-5-codex" },
  { label: "gpt-5", value: "gpt-5" },
];

export function commandModelOptionsFromModels(
  models: Model[],
): CommandModelOption[] {
  const seen = new Set<string>();
  return models
    .filter((model) => !model.hidden && model.model)
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault))
    .flatMap((model) => {
      if (seen.has(model.model)) {
        return [];
      }
      seen.add(model.model);
      const reasoningEfforts = model.supportedReasoningEfforts.map(
        (effort) => ({
          ...(effort.description ? { description: effort.description } : {}),
          value: effort.reasoningEffort,
        }),
      );
      return [
        {
          ...(model.defaultReasoningEffort
            ? { defaultReasoningEffort: model.defaultReasoningEffort }
            : {}),
          detail:
            model.displayName && model.displayName !== model.model
              ? model.displayName
              : undefined,
          isDefault: model.isDefault,
          label: model.model,
          ...(reasoningEfforts.length ? { reasoningEfforts } : {}),
          value: model.model,
        },
      ];
    });
}

export function mergeCommandModelOptions(
  backendOptions: CommandModelOption[],
  additionalOptions: CommandModelOption[] = fallbackCommandModelOptions,
): CommandModelOption[] {
  const seen = new Set<string>();
  return [...backendOptions, ...additionalOptions].filter((option) => {
    if (!option.value || seen.has(option.value)) {
      return false;
    }
    seen.add(option.value);
    return true;
  });
}

export function commandPermissionRuntimeSettings(
  permission: CommandComposerPermission,
): Pick<
  ThreadRuntimeSettings,
  "approvalPolicy" | "approvalsReviewer" | "sandboxMode"
> {
  switch (permission) {
    case "approve-for-me":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxMode: "workspace-write",
      };
    case "request-approval":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxMode: "workspace-write",
      };
    case "full-access":
      return {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxMode: "danger-full-access",
      };
  }
}

export function commandComposerRuntimeSettings({
  executionTarget,
  model,
  reasoningEffort,
  permission,
  scene,
  sceneMode,
  executionIntent = "none",
}: {
  executionTarget?: string;
  model?: string;
  reasoningEffort?: string;
  permission: CommandComposerPermission;
  scene?: ThreadSceneSelection["sceneId"];
  sceneMode?: NonNullable<ThreadSceneSelection["mode"]>;
  executionIntent?: CommandExecutionIntent;
}): ThreadRuntimeSettings {
  return {
    executionIntent,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(scene && sceneMode && executionTarget
      ? {
          scene: {
            sceneId: scene,
            mode: sceneMode,
            executionTarget: executionTargetSelection(executionTarget),
          },
        }
      : {}),
    ...commandPermissionRuntimeSettings(permission),
  };
}

function executionTargetSelection(
  value: string,
): ThreadSceneSelection["executionTarget"] {
  if (value === "crewon") {
    return { kind: "crewon" };
  }
  const separator = value.indexOf(":");
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (separator > 0 && id && kind === "agent") {
    return { kind, id };
  }
  if (separator > 0 && id && kind === "team") {
    return { kind, id };
  }
  if (separator > 0 && id && kind === "experts") {
    return { kind, id };
  }
  return { kind: "crewon" };
}
