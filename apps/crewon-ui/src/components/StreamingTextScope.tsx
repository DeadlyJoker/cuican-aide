import { createContext, useContext, type ReactNode } from "react";
import {
  EMPTY_STREAMING_PRESENTATION,
  type StreamingTextPresentation,
} from "../lib/thread/threadStreamingTextBuffer";

const Context = createContext(EMPTY_STREAMING_PRESENTATION);

export function StreamingTextScope({
  presentation,
  children,
}: {
  presentation: StreamingTextPresentation;
  children: ReactNode;
}) {
  return <Context.Provider value={presentation}>{children}</Context.Provider>;
}

export function useStreamingTextPreview(threadId: string | null) {
  const value = useContext(Context);
  const preview = threadId ? value.previews[threadId] : undefined;
  return {
    partial: preview?.partial ?? false,
    unavailable: Boolean(threadId && !preview && value.reclaimed),
  };
}
