type TurnWithStatus = {
  id: string;
  status: string;
};

export function appendThreadText(
  current: Record<string, string>,
  threadId: string,
  delta: string,
): Record<string, string> {
  return {
    ...current,
    [threadId]: `${current[threadId] ?? ""}${delta}`,
  };
}

export function clearThreadText(
  current: Record<string, string>,
  threadId: string,
): Record<string, string> {
  return {
    ...current,
    [threadId]: "",
  };
}

export function activeTurnByThreadAfterTurn(
  current: Record<string, string>,
  threadId: string,
  turn: TurnWithStatus,
): Record<string, string> {
  if (turn.status !== "inProgress") {
    return current;
  }
  return activeTurnByThreadAfterTurnId(current, threadId, turn.id);
}

export function activeTurnByThreadAfterTurnId(
  current: Record<string, string>,
  threadId: string,
  turnId: string,
): Record<string, string> {
  return {
    ...current,
    [threadId]: turnId,
  };
}
