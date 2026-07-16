use serde_json::json;

use super::UnknownContextPolicyFallback;
use super::member_shared_context;

#[test]
fn shared_digest_bounds_every_run_summary_field() {
    let oversized = |marker: char| marker.to_string().repeat(/*n*/ 12_000);
    let config = json!({
        "workspace": {
            "activity": {
                "runs": [{
                    "id": "run-bounded-context",
                    "title": oversized('T'),
                    "status": oversized('S'),
                    "loop": {
                        "status": oversized('L'),
                        "review": { "nextAction": oversized('N') }
                    },
                    "plan": [{
                        "status": oversized('P'),
                        "step": oversized('X')
                    }]
                }]
            }
        }
    });

    let digest = member_shared_context(
        &config,
        "run-bounded-context",
        "sharedDigest",
        UnknownContextPolicyFallback::LegacySharedDigest,
        /*is_zh*/ false,
    );
    assert!(digest.len() <= 2_000);
    assert!(digest.contains("Shared Office digest (bounded"));
    for marker in ['T', 'S', 'L', 'N', 'P', 'X'] {
        assert!(digest.contains(&marker.to_string().repeat(/*n*/ 8)));
        assert!(!digest.contains(&marker.to_string().repeat(/*n*/ 1_000)));
    }
    assert!(
        digest
            .lines()
            .skip(1)
            .all(|line| line.len() <= super::MAX_CONTEXT_LINE_BYTES)
    );
}

#[test]
fn shared_digest_with_recent_reserves_recent_and_active_delegation_slots() {
    let config = json!({
        "workspace": {
            "messages": (0..6).map(|index| json!({
                "author": format!("User {index}"),
                "text": format!("recent-{index}")
            })).collect::<Vec<_>>(),
            "activity": {
                "runs": [{
                    "id": "run-busy-context",
                    "title": "Busy run",
                    "status": "running",
                    "plan": (0..4).map(|index| json!({
                        "status": "pending",
                        "step": format!("plan-{index}")
                    })).collect::<Vec<_>>(),
                    "acceptanceCriteria": [{"status": "pending", "criterion": "acceptance"}],
                    "verificationChecks": [{"status": "pending", "check": "verification"}],
                    "evidence": [{"status": "observed", "summary": "evidence"}],
                    "risks": [{"severity": "high", "summary": "risk"}],
                    "delegations": (0..5).map(|index| json!({
                        "status": "running",
                        "task": format!("delegation-{index}")
                    })).collect::<Vec<_>>()
                }]
            }
        }
    });

    let digest = member_shared_context(
        &config,
        "run-busy-context",
        "sharedDigestWithRecent",
        UnknownContextPolicyFallback::LegacySharedDigest,
        /*is_zh*/ false,
    );

    assert_eq!(digest.lines().skip(1).count(), 14);
    assert_eq!(digest.matches("- Plan:").count(), 2);
    assert_eq!(digest.matches("- Delegation:").count(), 3);
    assert_eq!(digest.matches("- Recent message:").count(), 4);
    assert!(digest.contains("recent-2"));
    assert!(digest.contains("recent-5"));
}
