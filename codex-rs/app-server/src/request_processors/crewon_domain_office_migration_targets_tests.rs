use pretty_assertions::assert_eq;
use serde_json::json;

use super::config_references_turn;

#[test]
fn turn_reference_matches_manager_delegation_and_verification_runtime() {
    let config = json!({
        "workspace": {
            "threadId": "manager-thread",
            "activity": {
                "runs": [{
                    "turnId": "manager-turn",
                    "delegations": [{
                        "threadId": "member-thread",
                        "turnId": "member-turn"
                    }],
                    "verificationChecks": [{
                        "automationThreadId": "verification-thread",
                        "automationTurnId": "verification-turn"
                    }]
                }]
            }
        }
    });

    assert_eq!(
        [
            ("manager-thread", "manager-turn"),
            ("member-thread", "member-turn"),
            ("verification-thread", "verification-turn"),
        ]
        .map(|(thread_id, turn_id)| config_references_turn(&config, thread_id, turn_id)),
        [true, true, true]
    );
    assert!(!config_references_turn(
        &config,
        "manager-thread",
        "member-turn"
    ));
}
