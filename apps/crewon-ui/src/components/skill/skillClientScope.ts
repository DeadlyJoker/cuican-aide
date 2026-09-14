import { useLayoutEffect, useRef } from "react";

const clientKeys = new WeakMap<object, number>();
let nextClientKey = 0;

/** Replacing the authenticated client replaces all private component state. */
export function skillClientKey(client: object): number {
  let key = clientKeys.get(client);
  if (key === undefined) {
    key = ++nextClientKey;
    clientKeys.set(client, key);
  }
  return key;
}

/** Capture before awaiting, then check before any follow-up command or effect. */
export function useSkillOperationScope(client: object) {
  const scope = useRef({ client, epoch: 0, active: false });
  useLayoutEffect(() => {
    scope.current = { client, epoch: scope.current.epoch + 1, active: true };
    return () => {
      scope.current.active = false;
      scope.current.epoch += 1;
    };
  }, [client]);
  return () => {
    const epoch = scope.current.epoch;
    return () =>
      scope.current.active &&
      scope.current.client === client &&
      scope.current.epoch === epoch;
  };
}
