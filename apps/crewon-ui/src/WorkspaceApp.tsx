import { App } from "./App";
import { useControlApiClient } from "./lib/control-runtime/useControlApiClient";

/** Account restoration finishes before opening model and workspace connections. */
export default function WorkspaceApp() {
  const controlClient = useControlApiClient();
  return <App controlClient={controlClient} />;
}
