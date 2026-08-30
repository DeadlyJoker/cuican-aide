use crewon_app_server_protocol::OfficeMemberAddParams;
use crewon_app_server_protocol::OfficeSaveParams;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;

use super::super::CrewonDomainRequestProcessor;
use super::super::office_runtime_repair_transaction::OfficeRuntimeMutation;
use super::OFFICE_MEMBER_RUNTIME_SOURCE;
use super::apply_member_update;
use super::prepare;
use super::prepare_member;
use crate::office_runtime_contract::OFFICE_SCOPED_RUNTIME_VERSION;

#[tokio::test]
async fn prepare_strips_legacy_server_owned_fields_and_keeps_member_preferences() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let processor = CrewonDomainRequestProcessor::new();
    let saved = processor
        .office_save(OfficeSaveParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Member compatibility Office",
                "workspace": {
                    "members": [],
                    "messages": []
                }
            }),
        })
        .await
        .expect("save Office fixture");

    let prepared = prepare(OfficeMemberAddParams {
        cwd,
        config: saved.config,
        agent_id: "authoritative-agent".to_string(),
        member: json!({
            "memberId": "client-member-id",
            "member_id": "legacy-client-member-id",
            "agent_id": "spoofed-agent",
            "threadId": "shared-thread",
            "thread_id": "legacy-shared-thread",
            "name": "Reviewer",
            "role": "Review",
            "glyph": "R",
            "runtime": {
                "threadId": "shared-thread",
                "thread_id": "legacy-shared-thread",
                "sessionScope": "global",
                "session_scope": "global",
                "runtimeVersion": 999,
                "runtime_version": 999,
                "repairSourceThreadId": "client-source",
                "repair_source_thread_id": "client-source",
                "repairedAt": "client-time",
                "repaired_at": "client-time",
                "agentProfileSource": "client",
                "agent_profile_source": "client",
                "permissionProfile": "danger-full-access",
                "permission_profile": "danger-full-access",
                "context_policy": "isolated",
                "memory_scope": "private",
                "agent_profile": "Review release evidence",
                "customPreference": "keep-me"
            }
        }),
    })
    .await
    .expect("legacy member payload should be sanitized");

    assert_eq!(
        prepared.member,
        json!({
            "agentId": "authoritative-agent",
            "name": "Reviewer",
            "role": "Review",
            "glyph": "R",
            "runtime": {
                "contextPolicy": "isolated",
                "memoryScope": "private",
                "agentProfile": "Review release evidence",
                "customPreference": "keep-me"
            }
        })
    );
}

#[test]
fn existing_member_reuses_authoritative_identity_and_runtime_with_allowed_updates() {
    let mut config = json!({
        "title": "Member runtime Office",
        "workspace": {
            "members": [{
                "memberId": "server-member-id",
                "agentId": "agent-reviewer",
                "name": "Old reviewer",
                "threadId": "server-runtime-thread",
                "runtime": {
                    "threadId": "server-runtime-thread",
                    "sessionScope": "office",
                    "runtimeVersion": OFFICE_SCOPED_RUNTIME_VERSION,
                    "repairSourceThreadId": "server-source",
                    "repairedAt": "server-time",
                    "agentProfileSource": OFFICE_MEMBER_RUNTIME_SOURCE,
                    "permissionProfile": "read-only",
                    "contextPolicy": "sharedDigest",
                    "memoryScope": "privateAndShared",
                    "agentProfile": "Old profile"
                }
            }]
        }
    });
    let member = prepare_member(
        json!({
            "memberId": "client-member-id",
            "threadId": "client-runtime-thread",
            "name": "Reviewer",
            "role": "Release review",
            "runtime": {
                "threadId": "client-runtime-thread",
                "permissionProfile": "danger-full-access",
                "contextPolicy": "isolated",
                "memoryScope": "private",
                "agentProfile": "Review release evidence",
                "customPreference": "keep-me"
            }
        }),
        "agent-reviewer",
        None,
    )
    .expect("sanitize member update");

    let mutation = apply_member_update(
        &mut config,
        "agent-reviewer",
        member,
        "unused-candidate-id",
        "unused-runtime-thread",
        "unused-source-thread",
    )
    .expect("apply existing member update");

    assert!(matches!(mutation, OfficeRuntimeMutation::Updated));
    assert_eq!(
        config["workspace"]["members"][0],
        json!({
            "memberId": "server-member-id",
            "agentId": "agent-reviewer",
            "name": "Reviewer",
            "role": "Release review",
            "threadId": "server-runtime-thread",
            "runtime": {
                "threadId": "server-runtime-thread",
                "sessionScope": "office",
                "runtimeVersion": OFFICE_SCOPED_RUNTIME_VERSION,
                "repairSourceThreadId": "server-source",
                "repairedAt": "server-time",
                "agentProfileSource": OFFICE_MEMBER_RUNTIME_SOURCE,
                "permissionProfile": "read-only",
                "contextPolicy": "isolated",
                "memoryScope": "private",
                "agentProfile": "Review release evidence",
                "customPreference": "keep-me"
            }
        })
    );
}
