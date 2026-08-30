use pretty_assertions::assert_eq;
use serde_json::json;

use super::RepairedRuntimeAuthorityError;
use super::preserve_repaired_runtime_bindings;

#[test]
fn stale_save_preserves_repaired_runtime_and_new_group_chat_state() {
    let latest = json!({
        "workspace": {
            "members": [{
                "agentId": "agent-reviewer",
                "name": "Reviewer",
                "role": "Review",
                "threadId": "replacement-thread",
                "runtime": {
                    "threadId": "replacement-thread",
                    "sessionScope": "office",
                    "runtimeVersion": 2,
                    "repairSourceThreadId": "missing-thread",
                    "repairedAt": "2026-07-12T00:00:00Z",
                    "agentProfile": "name=Reviewer; role=Review",
                    "agentProfileSource": "officeMemberRepair",
                    "contextPolicy": "sharedDigest"
                }
            }],
            "activity": { "runs": [] }
        }
    });
    let mut proposed = json!({
        "workspace": {
            "members": [{
                "agentId": "agent-reviewer",
                "name": "Reviewer",
                "role": "Updated review role",
                "threadId": "missing-thread",
                "runtime": {
                    "threadId": "missing-thread",
                    "contextPolicy": "taskOnly"
                }
            }],
            "messages": [{ "author": "User", "text": "Keep this group-chat update" }],
            "activity": {
                "runs": [{
                    "delegationRoutes": [{
                        "agentId": "agent-reviewer",
                        "threadId": "missing-thread",
                        "target": "missing-thread"
                    }, {
                        "agentId": "agent-reviewer",
                        "targetKind": "automation",
                        "threadId": "automation-thread",
                        "target": "automation-thread"
                    }],
                    "delegations": [{
                        "agentId": "agent-reviewer",
                        "threadId": "missing-thread",
                        "status": "pending"
                    }]
                }]
            }
        }
    });

    assert!(
        preserve_repaired_runtime_bindings(&latest, &mut proposed)
            .expect("preserve repaired binding")
    );

    let member = &proposed["workspace"]["members"][0];
    assert_eq!(member["threadId"], "replacement-thread");
    assert_eq!(member["runtime"]["threadId"], "replacement-thread");
    assert_eq!(member["runtime"]["runtimeVersion"], 2);
    assert_eq!(member["runtime"]["contextPolicy"], "taskOnly");
    assert_eq!(
        member["runtime"]["agentProfile"],
        "name=Reviewer; role=Updated review role"
    );
    assert_eq!(
        proposed["workspace"]["activity"]["runs"][0]["delegationRoutes"][0]["target"],
        "replacement-thread"
    );
    assert_eq!(
        proposed["workspace"]["activity"]["runs"][0]["delegationRoutes"][1]["target"],
        "automation-thread"
    );
    assert_eq!(
        proposed["workspace"]["activity"]["runs"][0]["delegations"][0]["threadId"],
        "replacement-thread"
    );
    assert_eq!(
        proposed["workspace"]["messages"][0]["text"],
        "Keep this group-chat update"
    );
}

#[test]
fn removed_member_does_not_get_reintroduced() {
    let latest = json!({
        "workspace": {
            "members": [{
                "agentId": "agent-reviewer",
                "name": "Reviewer",
                "runtime": {
                    "threadId": "replacement-thread",
                    "sessionScope": "office",
                    "runtimeVersion": 2,
                    "repairSourceThreadId": "missing-thread",
                    "agentProfileSource": "officeMemberRepair"
                }
            }]
        }
    });
    let mut proposed = json!({
        "workspace": {
            "members": [],
            "activity": { "runs": [] }
        }
    });

    assert!(
        !preserve_repaired_runtime_bindings(&latest, &mut proposed)
            .expect("removed member is allowed")
    );
    assert_eq!(proposed["workspace"]["members"], json!([]));
}

#[test]
fn duplicate_repaired_agent_members_are_rejected() {
    let latest = repaired_latest_config();
    let mut proposed = json!({
        "workspace": {
            "members": [{
                "agentId": "agent-reviewer",
                "runtime": { "threadId": "missing-thread" }
            }, {
                "agentId": "agent-reviewer",
                "runtime": { "threadId": "missing-thread" }
            }]
        }
    });

    let conflict = preserve_repaired_runtime_bindings(&latest, &mut proposed)
        .expect_err("duplicate repaired agent members must conflict");
    assert!(matches!(
        conflict,
        RepairedRuntimeAuthorityError::ConflictingBinding { agent_id }
            if agent_id == "agent-reviewer"
    ));
}

#[test]
fn repaired_thread_cannot_transfer_to_another_agent() {
    let latest = repaired_latest_config();
    let proposed_configs = [
        json!({
            "workspace": {
                "members": [{
                    "agentId": "agent-writer",
                    "runtime": { "threadId": "replacement-thread" }
                }]
            }
        }),
        json!({
            "workspace": {
                "members": [{
                    "agentId": "agent-reviewer",
                    "runtime": { "threadId": "missing-thread" }
                }, {
                    "agentId": "agent-writer",
                    "threadId": "replacement-thread"
                }]
            }
        }),
    ];

    for mut proposed in proposed_configs {
        let conflict = preserve_repaired_runtime_bindings(&latest, &mut proposed)
            .expect_err("repaired thread ownership must not transfer across agents");
        assert!(matches!(
            conflict,
            RepairedRuntimeAuthorityError::ConflictingBinding { agent_id }
                if agent_id == "agent-reviewer"
        ));
    }
}

#[test]
fn explicit_third_runtime_binding_is_rejected() {
    let latest = json!({
        "workspace": {
            "members": [{
                "agentId": "agent-reviewer",
                "runtime": {
                    "threadId": "replacement-thread",
                    "sessionScope": "office",
                    "runtimeVersion": 2,
                    "repairSourceThreadId": "missing-thread",
                    "agentProfileSource": "officeMemberRepair"
                }
            }]
        }
    });
    let mut proposed = json!({
        "workspace": {
            "members": [{
                "agentId": "agent-reviewer",
                "runtime": { "threadId": "different-thread" }
            }]
        }
    });

    let conflict = preserve_repaired_runtime_bindings(&latest, &mut proposed)
        .expect_err("third binding must conflict");
    assert!(matches!(
        conflict,
        RepairedRuntimeAuthorityError::ConflictingBinding { agent_id }
            if agent_id == "agent-reviewer"
    ));
}

#[test]
fn divergent_member_thread_fields_are_rejected() {
    let latest = repaired_latest_config();
    let mut proposed = json!({
        "workspace": {
            "members": [{
                "agentId": "agent-reviewer",
                "threadId": "different-thread",
                "runtime": { "threadId": "missing-thread" }
            }]
        }
    });

    let conflict = preserve_repaired_runtime_bindings(&latest, &mut proposed)
        .expect_err("divergent member thread fields must conflict");
    assert!(matches!(
        conflict,
        RepairedRuntimeAuthorityError::ConflictingBinding { agent_id }
            if agent_id == "agent-reviewer"
    ));
}

#[test]
fn divergent_route_thread_fields_are_rejected() {
    let latest = repaired_latest_config();
    let mut proposed = json!({
        "workspace": {
            "members": [{
                "agentId": "agent-reviewer",
                "runtime": { "threadId": "missing-thread" }
            }],
            "activity": {
                "runs": [{
                    "delegationRoutes": [{
                        "agentId": "agent-reviewer",
                        "threadId": "missing-thread",
                        "target": "different-thread"
                    }]
                }]
            }
        }
    });

    let conflict = preserve_repaired_runtime_bindings(&latest, &mut proposed)
        .expect_err("divergent route thread fields must conflict");
    assert!(matches!(
        conflict,
        RepairedRuntimeAuthorityError::ConflictingBinding { agent_id }
            if agent_id == "agent-reviewer"
    ));
}

#[test]
fn divergent_legacy_route_thread_fields_are_rejected() {
    let latest = repaired_latest_config();
    let mut proposed = json!({
        "workspace": {
            "members": [{
                "agentId": "agent-reviewer",
                "name": "Reviewer",
                "runtime": { "threadId": "missing-thread" }
            }],
            "activity": {
                "runs": [{
                    "delegationRoutes": [{
                        "member": "Reviewer",
                        "threadId": "different-thread",
                        "target": "replacement-thread"
                    }]
                }]
            }
        }
    });

    let conflict = preserve_repaired_runtime_bindings(&latest, &mut proposed)
        .expect_err("divergent legacy route thread fields must conflict");
    assert!(matches!(
        conflict,
        RepairedRuntimeAuthorityError::ConflictingBinding { agent_id }
            if agent_id == "agent-reviewer"
    ));
}

#[test]
fn unnamed_repaired_member_rejects_unprovable_legacy_owner() {
    let latest = json!({
        "workspace": {
            "members": [{
                "agentId": "agent-reviewer",
                "runtime": {
                    "threadId": "replacement-thread",
                    "sessionScope": "office",
                    "runtimeVersion": 2,
                    "repairSourceThreadId": "missing-thread",
                    "agentProfileSource": "officeMemberRepair"
                }
            }]
        }
    });
    let mut proposed = json!({
        "workspace": {
            "members": [{
                "agentId": "agent-reviewer",
                "runtime": { "threadId": "missing-thread" }
            }],
            "activity": {
                "runs": [{
                    "delegationRoutes": [{
                        "member": "Reviewer",
                        "threadId": "missing-thread",
                        "target": "missing-thread"
                    }]
                }]
            }
        }
    });

    let conflict = preserve_repaired_runtime_bindings(&latest, &mut proposed)
        .expect_err("legacy row owner cannot be inferred without a repaired member name");
    assert!(matches!(
        conflict,
        RepairedRuntimeAuthorityError::ConflictingBinding { agent_id }
            if agent_id == "agent-reviewer"
    ));
}

#[test]
fn large_runtime_ledger_is_fully_normalized() {
    let latest = json!({
        "workspace": {
            "members": [{
                "agentId": "agent-reviewer",
                "name": "Reviewer",
                "runtime": {
                    "threadId": "replacement-thread",
                    "sessionScope": "office",
                    "runtimeVersion": 2,
                    "repairSourceThreadId": "missing-thread",
                    "agentProfileSource": "officeMemberRepair"
                }
            }]
        }
    });
    let mut runs = (0..128).map(|_| json!({})).collect::<Vec<_>>();
    runs.push(json!({
        "delegationRoutes": [{
            "agentId": "agent-reviewer",
            "threadId": "missing-thread",
            "target": "missing-thread"
        }]
    }));
    let mut proposed = json!({
        "workspace": {
            "members": [{
                "agentId": "agent-reviewer",
                "runtime": { "threadId": "missing-thread" }
            }],
            "activity": {
                "runs": runs
            }
        }
    });

    assert!(
        preserve_repaired_runtime_bindings(&latest, &mut proposed)
            .expect("large ledger remains compatible")
    );
    assert_eq!(
        proposed["workspace"]["activity"]["runs"][128]["delegationRoutes"][0]["target"],
        "replacement-thread"
    );
}

#[test]
fn forged_repair_authority_is_rejected() {
    let latest = json!({
        "workspace": {
            "members": [{
                "agentId": "agent-reviewer",
                "runtime": { "threadId": "ordinary-thread" }
            }]
        }
    });
    let mut proposed = json!({
        "workspace": {
            "members": [{
                "agentId": "agent-reviewer",
                "runtime": {
                    "threadId": "forged-thread",
                    "sessionScope": "office",
                    "runtimeVersion": 2,
                    "repairSourceThreadId": "ordinary-thread",
                    "repairedAt": "2026-07-12T00:00:00Z",
                    "agentProfileSource": "officeMemberRepair"
                }
            }]
        }
    });

    let error = preserve_repaired_runtime_bindings(&latest, &mut proposed)
        .expect_err("client repair authority must be rejected");
    assert!(matches!(
        error,
        RepairedRuntimeAuthorityError::ForgedAuthority { agent_id }
            if agent_id == "agent-reviewer"
    ));
}

fn repaired_latest_config() -> serde_json::Value {
    json!({
        "workspace": {
            "members": [{
                "agentId": "agent-reviewer",
                "name": "Reviewer",
                "runtime": {
                    "threadId": "replacement-thread",
                    "sessionScope": "office",
                    "runtimeVersion": 2,
                    "repairSourceThreadId": "missing-thread",
                    "agentProfileSource": "officeMemberRepair"
                }
            }]
        }
    })
}
