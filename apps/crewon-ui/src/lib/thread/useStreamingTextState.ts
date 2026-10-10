import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  createStreamingTextBuffer,
  EMPTY_STREAMING_PRESENTATION,
  type StreamingTextByThread,
  type StreamingTextPresentation,
} from "./threadStreamingTextBuffer";

export function useStreamingTextState(selectedThreadId: string | null) {
  const [streamingTextByThread, setText] = useState<StreamingTextByThread>({});
  const [streamingTextPresentation, setPresentation] =
    useState<StreamingTextPresentation>(EMPTY_STREAMING_PRESENTATION);
  const ownerRef = useRef<ReturnType<typeof createStreamingTextBuffer> | null>(
    null,
  );

  useEffect(() => {
    // Effects can be disposed and replayed in StrictMode. Each lifetime owns
    // its preview and listener; a closed lifetime cannot publish later.
    const owner = createStreamingTextBuffer(
      (update) =>
        setText((current) =>
          ownerRef.current === owner ? update(current) : current,
        ),
      {
        onPresentation: (next) =>
          setPresentation((current) =>
            ownerRef.current === owner ? next : current,
          ),
      },
    );
    ownerRef.current = owner;
    setText({});
    setPresentation(EMPTY_STREAMING_PRESENTATION);
    const visibilityChanged = () =>
      owner.setVisible(document.visibilityState !== "hidden");
    visibilityChanged();
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      document.removeEventListener("visibilitychange", visibilityChanged);
      owner.dispose();
      if (ownerRef.current === owner) ownerRef.current = null;
    };
  }, []);
  useEffect(() => {
    ownerRef.current?.setFocus(selectedThreadId);
  }, [selectedThreadId]);

  const setStreamingTextByThread: Dispatch<
    SetStateAction<StreamingTextByThread>
  > = useCallback((next) => {
    ownerRef.current?.replace(next);
  }, []);
  const appendStreamingTextDelta = useCallback((id: string, delta: string) => {
    ownerRef.current?.append(id, delta);
  }, []);
  const resetStreamingText = useCallback((id: string) => {
    ownerRef.current?.reset(id);
  }, []);
  const waitForStreamingTextDrain = useCallback(
    (id: string) => ownerRef.current?.whenDrained(id) ?? Promise.resolve(),
    [],
  );
  const streamingTextActivity = useCallback(
    (id: string) => ownerRef.current?.activity(id) ?? "unavailable",
    [],
  );
  return {
    streamingTextByThread,
    streamingTextPresentation,
    setStreamingTextByThread,
    appendStreamingTextDelta,
    resetStreamingText,
    waitForStreamingTextDrain,
    streamingTextActivity,
  };
}
