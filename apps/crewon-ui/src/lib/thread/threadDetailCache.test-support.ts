import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

export function detailThread(id: string, text = `Answer ${id}`): Thread {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: `Request ${id}`,
    ephemeral: false,
    modelProvider: "crewon-control",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    path: null,
    cwd: "",
    clientVersion: "control-api-v1",
    source: { custom: "crewon-control" },
    threadSource: "control-api",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: `Title ${id}`,
    turns: [
      {
        id: `turn-${id}`,
        status: "completed",
        itemsView: "full",
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1_000,
        items: [
          {
            id: `user-${id}`,
            type: "userMessage",
            clientId: null,
            content: [
              { type: "text", text: `Request ${id}`, text_elements: [] },
            ],
          },
          {
            id: `answer-${id}`,
            type: "agentMessage",
            text,
            phase: "final_answer",
            memoryCitation: null,
          },
        ],
      },
    ],
  };
}

export const transcriptLabels = {
  commandLabel: "Command",
  crewonLabel: "CrewON",
  emptyDescription: "Start",
  emptyTitle: "Ready",
  filesLabel: "Files",
  loadingLabel: "Loading history",
  modeCodeDescription: "Code",
  modeCodeLabel: "Code",
  modeOfficeDescription: "Office",
  modeOfficeLabel: "Office",
  modeTitleLabel: "Mode",
  planLabel: "Plan",
  reasoningLabel: "Reasoning",
  stopLabel: "Stop",
  youLabel: "You",
};
