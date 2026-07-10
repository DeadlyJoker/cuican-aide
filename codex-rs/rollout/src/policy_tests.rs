use pretty_assertions::assert_eq;

use super::persisted_rollout_items;
use super::should_persist_event_msg;
use crate::protocol::EventMsg;
use crate::protocol::RolloutItem;

fn exec_command_end_event() -> EventMsg {
    serde_json::from_value(serde_json::json!({
        "type": "exec_command_end",
        "call_id": "exec-1",
        "process_id": "pid-1",
        "turn_id": "turn-1",
        "completed_at_ms": 12,
        "command": ["pwd"],
        "cwd": "/tmp",
        "parsed_cmd": [
            {
                "type": "unknown",
                "cmd": "pwd"
            }
        ],
        "source": "agent",
        "stdout": "/tmp\n",
        "stderr": "",
        "aggregated_output": "/tmp\n",
        "exit_code": 0,
        "duration": {
            "secs": 0,
            "nanos": 12000000
        },
        "formatted_output": "/tmp\n",
        "status": "completed"
    }))
    .expect("valid exec command end event")
}

fn exec_command_output_delta_event() -> EventMsg {
    serde_json::from_value(serde_json::json!({
        "type": "exec_command_output_delta",
        "call_id": "exec-1",
        "stream": "stdout",
        "chunk": "L3RtcAo="
    }))
    .expect("valid exec command output delta event")
}

#[test]
fn persists_command_completion_without_stream_deltas() {
    let command_end = exec_command_end_event();
    let output_delta = exec_command_output_delta_event();

    assert!(should_persist_event_msg(&command_end));
    assert!(!should_persist_event_msg(&output_delta));

    let items = persisted_rollout_items(&[
        RolloutItem::EventMsg(output_delta),
        RolloutItem::EventMsg(command_end),
    ]);
    assert_eq!(items.len(), 1);
    assert!(matches!(
        &items[0],
        RolloutItem::EventMsg(EventMsg::ExecCommandEnd(event))
            if event.call_id == "exec-1" && event.aggregated_output == "/tmp\n"
    ));
}
