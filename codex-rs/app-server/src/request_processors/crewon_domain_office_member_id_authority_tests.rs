use pretty_assertions::assert_eq;
use serde_json::json;
use uuid::Uuid;

use super::OfficeMemberIdentityWrite;
use super::prepare_write;
use crate::error_code::INVALID_PARAMS_ERROR_CODE;

#[test]
fn preserve_existing_backfills_multiple_legacy_members_by_unique_stable_owner() {
    let latest = json!({
        "workspace": {
            "members": [
                {
                    "agentId": "agent-a",
                    "name": "Old agent-backed name"
                },
                {
                    "name": "Coordinator"
                }
            ]
        }
    });
    let mut proposed = json!({
        "workspace": {
            "members": [
                {
                    "agentId": "agent-a",
                    "name": "Renamed agent-backed member"
                },
                {
                    "name": "Coordinator"
                }
            ]
        }
    });

    prepare_write(
        Some(&latest),
        &mut proposed,
        OfficeMemberIdentityWrite::PreserveExisting,
    )
    .expect("backfill unique legacy members");

    let members = proposed["workspace"]["members"]
        .as_array()
        .expect("members array");
    let member_ids = members
        .iter()
        .map(|member| {
            let member_id = member["memberId"].as_str().expect("memberId");
            Uuid::parse_str(member_id).expect("server UUID");
            member_id
        })
        .collect::<Vec<_>>();
    assert_ne!(member_ids[0], member_ids[1]);
    assert_eq!(members[0]["name"], "Renamed agent-backed member");
    assert_eq!(members[1]["name"], "Coordinator");
}

#[test]
fn preserve_existing_rejects_duplicate_legacy_stable_owners() {
    let latest = json!({
        "workspace": {
            "members": [
                { "agentId": "agent-a", "name": "First" },
                { "agentId": "agent-a", "name": "Second" }
            ]
        }
    });
    let mut proposed = json!({
        "workspace": {
            "members": [{ "agentId": "agent-a", "name": "First" }]
        }
    });

    let error = prepare_write(
        Some(&latest),
        &mut proposed,
        OfficeMemberIdentityWrite::PreserveExisting,
    )
    .expect_err("duplicate persisted owners must fail closed");

    assert_eq!(error.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(
        error.message,
        "persisted Office members do not have a unique stable owner for memberId backfill"
    );
}

#[test]
fn preserve_existing_rejects_conflicts_between_canonical_and_legacy_owners() {
    let latest = json!({
        "workspace": {
            "members": [
                {
                    "memberId": "canonical-member",
                    "agentId": "agent-a",
                    "name": "Canonical"
                },
                {
                    "agentId": "agent-a",
                    "name": "Legacy duplicate"
                }
            ]
        }
    });
    let mut proposed = json!({
        "workspace": {
            "members": [{ "agentId": "agent-a", "name": "Canonical" }]
        }
    });

    let error = prepare_write(
        Some(&latest),
        &mut proposed,
        OfficeMemberIdentityWrite::PreserveExisting,
    )
    .expect_err("canonical and legacy owner conflict must fail closed");

    assert_eq!(error.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(
        error.message,
        "persisted Office members do not have a unique stable owner for memberId backfill"
    );
}

#[test]
fn preserve_existing_rejects_duplicate_proposed_consumers_of_one_legacy_owner() {
    let latest = json!({
        "workspace": {
            "members": [{ "name": "Coordinator" }]
        }
    });
    let mut proposed = json!({
        "workspace": {
            "members": [
                { "name": "Coordinator" },
                { "name": "Coordinator" }
            ]
        }
    });

    let error = prepare_write(
        Some(&latest),
        &mut proposed,
        OfficeMemberIdentityWrite::PreserveExisting,
    )
    .expect_err("one legacy owner cannot be consumed twice");

    assert_eq!(error.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(
        error.message,
        "workspace members without memberId must have distinct stable owners"
    );
}
