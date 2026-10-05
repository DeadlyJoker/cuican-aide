import { createContext, useContext, type ReactNode } from "react";
import type { ProjectPlanningProposal } from "@crewon/contracts/project-planning";
export type ProjectPlanningNavigation = Readonly<{
  threadId: string | null;
  canOpen(proposal: ProjectPlanningProposal): boolean;
  open(proposal: ProjectPlanningProposal): void;
}>;
const Navigation = createContext<ProjectPlanningNavigation | null>(null);
const Run = createContext<string | null>(null);
export function ProjectPlanningScope({
  value,
  children,
}: {
  value: ProjectPlanningNavigation;
  children: ReactNode;
}) {
  return <Navigation.Provider value={value}>{children}</Navigation.Provider>;
}
export function ProjectPlanningRunScope({
  runId,
  children,
}: {
  runId: string;
  children: ReactNode;
}) {
  return <Run.Provider value={runId}>{children}</Run.Provider>;
}
export function useProjectPlanningOrigin() {
  return { navigation: useContext(Navigation), runId: useContext(Run) };
}
