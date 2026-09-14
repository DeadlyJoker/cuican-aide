import type { MessageView, ThreadView } from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";

import type { AgentConfig } from "../domain/crewonDomain";
import type {
  ExpertRole,
  ExpertTeamRecordReference,
} from "../experts/expertTeamRecord";
import type { Locale } from "../i18n";
import {
  createControlOffice,
  type ControlOfficeClient,
} from "../office/controlOfficeRuntime";
import type { OfficeConfigRecordReference } from "../office/officePanelFromRecord";

const MARKER_PREFIX = "__crewon_experts_definition__:";
const RECORD_MARKER = "[Control Experts · definition]";
const OFFICE_TITLE_PREFIX = "专家团 · ";
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_EXPERT_RESPONSIBILITY_CHARACTERS = 240;
const MAX_EXPERT_ROLE_CHARACTERS = 32;

type ExpertProfileStorage = Pick<Storage, "getItem" | "setItem"> | null;

export type ControlExpertRuntimeClient = ControlOfficeClient &
  Pick<
    ControlApiClient,
    | "appendThreadMessage"
    | "createThread"
    | "listThreadMessages"
    | "listThreads"
  >;

export type ControlExpertCreateInput = Readonly<{
  title: string;
  goal: string;
  leader: ExpertRole;
  experts: readonly [ExpertRole, ExpertRole];
}>;

/** Persists expert-team metadata beside a real multi-member Control Office. */
export class ControlExpertRuntime {
  readonly #client: ControlExpertRuntimeClient;
  readonly #locale: Locale;
  readonly #profileStorage: ExpertProfileStorage | undefined;

  constructor(config: {
    client: ControlExpertRuntimeClient;
    locale: Locale;
    profileStorage?: ExpertProfileStorage;
  }) {
    this.#client = config.client;
    this.#locale = config.locale;
    this.#profileStorage = config.profileStorage;
  }

  async createExpertTeam(input: {
    definition: ControlExpertCreateInput;
    agents: readonly { config: AgentConfig; filePath: string }[];
  }): Promise<
    Readonly<{
      record: ExpertTeamRecordReference;
      office: OfficeConfigRecordReference;
    }>
  > {
    validateDefinition(input.definition);
    if (input.agents.length === 0) {
      throw new Error("control_expert_agent_version_unavailable");
    }
    const roles = [input.definition.leader, ...input.definition.experts];
    const office = await createControlOffice({
      client: this.#client,
      locale: this.#locale,
      title: `${OFFICE_TITLE_PREFIX}${input.definition.title.trim()}`,
      members: roles.map((role, index) => ({
        config: input.agents[index % input.agents.length]!.config,
        displayName: `${role.name} · ${role.role}`,
        responsibility: expertRoleResponsibility(
          role,
          index === 0,
          this.#locale,
        ),
      })),
      storage: this.#profileStorage,
    });
    if (office.authority !== "controlDefinition") {
      throw new Error("control_expert_office_response_invalid");
    }
    const record = recordFromDefinition(
      office.definition.officeVersionId,
      office.definition.officeId,
      input.definition,
    );
    const marker = await this.#client.createThread(
      { title: markerTitle(record.config.expertsId) },
      `experts.definition.${record.config.expertsId}`,
    );
    await this.#client.appendThreadMessage(
      marker.thread.threadId,
      {
        expectedRevision: marker.thread.revision,
        content: `${RECORD_MARKER}\n${JSON.stringify(record.config)}`,
      },
      `experts.definition.content.${record.config.expertsId}`,
    );
    return { record, office };
  }

  async listExpertTeams(): Promise<readonly ExpertTeamRecordReference[]> {
    const threads = await this.#listThreads();
    const records = await Promise.all(
      threads.flatMap((thread) => {
        const expertsId = parseMarkerTitle(thread.title);
        return expertsId === null
          ? []
          : [this.#loadRecord(thread.threadId, expertsId)];
      }),
    );
    return records
      .filter((record): record is ExpertTeamRecordReference => record !== null)
      .sort((left, right) =>
        right.config.recordRevision.localeCompare(left.config.recordRevision),
      );
  }

  async #loadRecord(
    threadId: string,
    expertsId: string,
  ): Promise<ExpertTeamRecordReference | null> {
    const response = await this.#client.listThreadMessages(threadId, {
      limit: PAGE_SIZE,
    });
    const definition = response.data.find(
      (message) =>
        message.role === "user" &&
        message.content.startsWith(`${RECORD_MARKER}\n`),
    );
    if (definition === undefined) return null;
    try {
      const config = JSON.parse(
        definition.content.slice(RECORD_MARKER.length + 1),
      );
      if (!isExpertConfig(config) || config.expertsId !== expertsId) {
        return null;
      }
      return {
        filePath: `control:experts:${expertsId}`,
        config: await this.#withStableOfficeIdentity(config),
      };
    } catch {
      return null;
    }
  }

  async #withStableOfficeIdentity(
    config: ExpertTeamRecordReference["config"],
  ): Promise<ExpertTeamRecordReference["config"]> {
    if (config.officeId !== undefined) return config;
    try {
      const { office } = await this.#client.getOffice(config.expertsId);
      const officeId = office.officeId.trim();
      if (
        !officeId ||
        office.officeVersionId !== config.expertsId ||
        office.title !== `${OFFICE_TITLE_PREFIX}${config.title.trim()}` ||
        office.members.length !== config.experts.length + 1 ||
        office.executionTargets.length !== office.members.length
      ) {
        return config;
      }
      return { ...config, officeId };
    } catch {
      // Legacy records remain usable as execution targets. Profile projection
      // stays fail-closed until their backing Office identity can be proven.
      return config;
    }
  }

  async #listThreads(): Promise<ThreadView[]> {
    const data: ThreadView[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.#client.listThreads({
        cursor,
        limit: PAGE_SIZE,
      });
      data.push(...response.data);
      if (response.nextCursor === null) return data;
      cursor = response.nextCursor;
    }
    throw new Error("control_expert_thread_page_limit_exceeded");
  }
}

export function isInternalControlExpertThread(thread: {
  name?: string | null;
  preview?: string | null;
  title?: string | null;
}): boolean {
  return (
    parseMarkerTitle(thread.title ?? thread.name ?? thread.preview ?? null) !==
    null
  );
}

export function isControlExpertOfficeRecord(
  record: OfficeConfigRecordReference,
): boolean {
  return record.config.title.startsWith(OFFICE_TITLE_PREFIX);
}

function recordFromDefinition(
  expertsId: string,
  officeId: string,
  definition: ControlExpertCreateInput,
): ExpertTeamRecordReference {
  return {
    filePath: `control:experts:${expertsId}`,
    config: {
      expertsId,
      officeId,
      title: definition.title.trim(),
      goal: definition.goal.trim(),
      leader: normalizeRole(definition.leader),
      experts: definition.experts.map(normalizeRole),
      recordRevision: new Date().toISOString(),
      workspaceKey: "control",
      ownerSubject: "control-session",
    },
  };
}

function normalizeRole(role: ExpertRole): ExpertRole {
  return {
    name: role.name.trim(),
    role: role.role.trim(),
    agentType: role.agentType,
    instructions: role.instructions?.trim() || null,
  };
}

function expertRoleResponsibility(
  role: ExpertRole,
  isLeader: boolean,
  locale: Locale,
): string {
  const roleDescription = role.role.trim().slice(0, MAX_EXPERT_ROLE_CHARACTERS);
  const lines =
    locale === "zh"
      ? [
          `角色职责：${roleDescription}`,
          ...(isLeader
            ? [
                "组长：你是唯一汇总出口；综合成员报告并保留未解决分歧，不得抹平冲突。",
              ]
            : []),
          role.agentType === "explorer"
            ? "Explorer：枚举证据、冲突、假设和未知；区分事实与推断，证据不足时不得收敛。"
            : "Worker：仅将已确认材料转成可执行方案、验收动作和完成标准；明确依赖与缺口，不得补造事实或证据。",
        ]
      : [
          `Role: ${roleDescription}`,
          ...(isLeader
            ? [
                "Leader: sole final synthesizer; preserve unresolved disagreements.",
              ]
            : []),
          role.agentType === "explorer"
            ? "Explorer: enumerate evidence, conflicts, assumptions and unknowns; distinguish fact from inference; no unsupported convergence."
            : "Worker: convert confirmed material into executable steps and acceptance checks; expose gaps; fabricate no evidence.",
        ];
  const required = lines.join("\n");
  const instructions = role.instructions?.trim();
  if (!instructions) return required;
  const label = locale === "zh" ? "补充要求：" : "Additional instructions: ";
  const available =
    MAX_EXPERT_RESPONSIBILITY_CHARACTERS - required.length - label.length - 1;
  return available <= 0
    ? required.slice(0, MAX_EXPERT_RESPONSIBILITY_CHARACTERS)
    : `${required}\n${label}${instructions.slice(0, available)}`;
}

function validateDefinition(definition: ControlExpertCreateInput): void {
  const roles = [definition.leader, ...definition.experts];
  if (
    !definition.title.trim() ||
    !definition.goal.trim() ||
    roles.some((role) => !role.name.trim() || !role.role.trim())
  ) {
    throw new Error("control_expert_definition_invalid");
  }
}

function markerTitle(expertsId: string): string {
  return `${MARKER_PREFIX}${encodeURIComponent(expertsId)}`;
}

function parseMarkerTitle(title: string | null): string | null {
  if (!title?.startsWith(MARKER_PREFIX)) return null;
  try {
    return decodeURIComponent(title.slice(MARKER_PREFIX.length)) || null;
  } catch {
    return null;
  }
}

function isExpertConfig(
  value: unknown,
): value is ExpertTeamRecordReference["config"] {
  if (!plain(value)) return false;
  return (
    typeof value.expertsId === "string" &&
    (value.officeId === undefined ||
      (typeof value.officeId === "string" && Boolean(value.officeId.trim()))) &&
    typeof value.title === "string" &&
    typeof value.goal === "string" &&
    typeof value.recordRevision === "string" &&
    typeof value.workspaceKey === "string" &&
    typeof value.ownerSubject === "string" &&
    isRole(value.leader) &&
    Array.isArray(value.experts) &&
    value.experts.length === 2 &&
    value.experts.every(isRole)
  );
}

function isRole(value: unknown): value is ExpertRole {
  return (
    plain(value) &&
    typeof value.name === "string" &&
    typeof value.role === "string" &&
    (value.agentType === "explorer" || value.agentType === "worker") &&
    (value.instructions === undefined ||
      value.instructions === null ||
      typeof value.instructions === "string")
  );
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
