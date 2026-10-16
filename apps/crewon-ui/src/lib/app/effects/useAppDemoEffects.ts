import { useEffect } from "react";
import {
  localizeDemoThreadsAction,
  syncDemoInspectorStateAction,
} from "../appDemoStateActions";

type AppDemoEffectsParams = Parameters<typeof localizeDemoThreadsAction>[0] &
  Parameters<typeof syncDemoInspectorStateAction>[0];

/** Demo presentation state has no transport or connection ownership. */
export function useAppDemoEffects({
  connectionState,
  locale,
  setThreads,
  isDemo,
  selectedThread,
  selectedThreadId,
  setAccountStatus,
  setConversationSummary,
  setGitRemoteDiff,
  setThreadGoal,
}: AppDemoEffectsParams) {
  useEffect(() => {
    localizeDemoThreadsAction({
      connectionState,
      locale,
      setThreads,
    });
  }, [connectionState, locale, setThreads]);

  useEffect(() => {
    syncDemoInspectorStateAction({
      isDemo,
      locale,
      selectedThread,
      selectedThreadId,
      setAccountStatus,
      setConversationSummary,
      setGitRemoteDiff,
      setThreadGoal,
    });
  }, [
    isDemo,
    locale,
    selectedThread,
    selectedThreadId,
    setAccountStatus,
    setConversationSummary,
    setGitRemoteDiff,
    setThreadGoal,
  ]);
}
