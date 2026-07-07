use super::*;
use pretty_assertions::assert_eq;

#[test]
fn office_turn_from_completed_status_preserves_final_message() {
    let got = office_turn_from_agent_status(
        "turn-1",
        &AgentStatus::Completed(Some("Checklist complete.".to_string())),
    );

    assert_eq!(
        got,
        Turn {
            id: "turn-1".to_string(),
            items: vec![ThreadItem::AgentMessage {
                id: "turn-1-final-message".to_string(),
                text: "Checklist complete.".to_string(),
                phase: None,
                memory_citation: None,
            }],
            items_view: TurnItemsView::Full,
            error: None,
            status: TurnStatus::Completed,
            started_at: None,
            completed_at: None,
            duration_ms: None,
        }
    );
}

#[test]
fn office_turn_from_error_status_becomes_failed_turn() {
    let got = office_turn_from_agent_status("turn-1", &AgentStatus::Errored("boom".to_string()));

    assert_eq!(
        got,
        Turn {
            id: "turn-1".to_string(),
            items: Vec::new(),
            items_view: TurnItemsView::Full,
            error: Some(TurnError {
                message: "boom".to_string(),
                codex_error_info: None,
                additional_details: None,
            }),
            status: TurnStatus::Failed,
            started_at: None,
            completed_at: None,
            duration_ms: None,
        }
    );
}

#[test]
fn office_status_fallback_waits_for_target_turn_to_appear() {
    let got = office_status_fallback_ready(
        &AgentStatus::Completed(Some("previous turn".to_string())),
        OFFICE_AUTO_DISPATCH_STATUS_FALLBACK_DELAY - Duration::from_millis(1),
        /*target_turn_seen*/ true,
    );

    assert!(!got);
}

#[test]
fn office_status_fallback_rejects_stale_terminal_status_before_target_turn() {
    let got = office_status_fallback_ready(
        &AgentStatus::Interrupted,
        OFFICE_AUTO_DISPATCH_STATUS_FALLBACK_DELAY,
        /*target_turn_seen*/ false,
    );

    assert!(!got);
}

#[test]
fn office_status_fallback_rejects_interrupted_status_after_target_turn() {
    let got = office_status_fallback_ready(
        &AgentStatus::Interrupted,
        OFFICE_AUTO_DISPATCH_STATUS_FALLBACK_DELAY,
        /*target_turn_seen*/ true,
    );

    assert!(!got);
}

#[test]
fn office_status_fallback_allows_terminal_status_after_delay() {
    let got = office_status_fallback_ready(
        &AgentStatus::Completed(Some("fallback result".to_string())),
        OFFICE_AUTO_DISPATCH_STATUS_FALLBACK_DELAY,
        /*target_turn_seen*/ true,
    );

    assert!(got);
}
