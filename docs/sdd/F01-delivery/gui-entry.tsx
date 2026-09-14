import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ControlApiClient } from "../../../packages/control-client/src/index.ts";
import { DeliveryPanel } from "../../../apps/crewon-ui/src/components/workbench/DeliveryPanel";
import "./gui.css";
const session = await (await fetch("/__acceptance/session")).json();
const client = new ControlApiClient({
  baseUrl: location.origin,
  accessToken: session.sessionToken,
  csrfToken: session.csrfToken,
  origin: session.origin,
});
function App() {
  const [threadId, setThreadId] = useState(session.threadId);
  return (
    <main>
      <header>
        <h1>文件交付 · 合成材料验收</h1>
        <p>生产组件与真实 Control API / SQLite；模型未接入此验收页。</p>
        <button onClick={() => setThreadId(session.threadId)}>订单任务</button>
        <button onClick={() => setThreadId(session.otherThreadId)}>
          隔离任务
        </button>
      </header>
      <DeliveryPanel client={client.delivery} threadId={threadId} locale="zh" />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
