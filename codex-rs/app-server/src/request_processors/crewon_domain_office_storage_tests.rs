use std::path::Path;
use std::path::PathBuf;

use crewon_app_server_protocol::OfficeMessageSubmitParams;
use crewon_app_server_protocol::OfficeReadParams;
use crewon_app_server_protocol::OfficeSaveParams;
use pretty_assertions::assert_eq;
use serde_json::Value as JsonValue;
use serde_json::json;
use tempfile::TempDir;
use uuid::Uuid;

use super::super::CrewonDomainRequestProcessor;
use super::MAX_OFFICE_RECORD_BYTES;
use super::OfficeIdentityLookup;
use super::find_office_record;
use super::list_office_records_for_scheduler;
use super::read_office_record_strict;
use crate::error_code::INTERNAL_ERROR_CODE;
use crate::error_code::INVALID_PARAMS_ERROR_CODE;

fn legacy_office_config(title: &str, thread_id: &str, message: &str) -> JsonValue {
    json!({
        "title": title,
        "workspace": {
            "threadId": thread_id,
            "messages": [{
                "author": "User",
                "text": message
            }]
        }
    })
}

async fn save(
    processor: &CrewonDomainRequestProcessor,
    cwd: &str,
    config: JsonValue,
) -> crewon_app_server_protocol::OfficeSaveResponse {
    if super::office_record_id(&config).is_none()
        && let Some(thread_id) = config["workspace"]["threadId"].as_str()
    {
        let directory = super::super::domain_directory(cwd, super::super::DomainKind::Office)
            .expect("Office directory");
        std::fs::create_dir_all(&directory).expect("create legacy Office directory");
        let existing = super::find_office_record_ignoring_unreadable(
            &directory,
            OfficeIdentityLookup::LegacyThreadId(thread_id),
        )
        .await
        .expect("probe legacy Office fixture");
        if existing.is_none() {
            super::super::write_domain_record(
                super::super::DomainKind::Office,
                &directory.join(format!("legacy-{}.json", Uuid::now_v7())),
                "2026-07-15T00:00:00.000Z".to_string(),
                config.clone(),
            )
            .await
            .expect("seed persisted legacy Office fixture");
        }
    }
    processor
        .office_save(OfficeSaveParams {
            cwd: cwd.to_string(),
            config,
        })
        .await
        .expect("save Office")
}

fn server_member_ids(config: &JsonValue) -> Vec<String> {
    config["workspace"]["members"]
        .as_array()
        .expect("Office members")
        .iter()
        .map(|member| {
            assert!(member.get("member_id").is_none());
            let member_id = member["memberId"]
                .as_str()
                .expect("server-generated memberId");
            Uuid::parse_str(member_id).expect("memberId must be a UUID");
            member_id.to_string()
        })
        .collect()
}

fn office_with_client_member_ids(title: &str) -> JsonValue {
    json!({
        "title": title,
        "workspace": {
            "members": [
                {
                    "memberId": "client-member-a",
                    "agentId": "agent-a",
                    "name": "Member A"
                },
                {
                    "member_id": "client-member-b",
                    "agent_id": "agent-b",
                    "name": "Member B"
                },
                {
                    "name": "Member without a client id"
                }
            ],
            "messages": []
        }
    })
}

#[tokio::test]
async fn new_office_write_replaces_every_client_member_id_with_a_server_uuid() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let mut config = office_with_client_member_ids("New Office");

    super::save_office_record(&cwd, &mut config, super::OfficeWriteIntent::Create)
        .await
        .expect("create Office with initial members");

    let member_ids = server_member_ids(&config);
    assert_eq!(member_ids.len(), 3);
    assert_eq!(
        member_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        3
    );
    assert!(
        !member_ids
            .iter()
            .any(|member_id| { member_id == "client-member-a" || member_id == "client-member-b" })
    );
}

#[tokio::test]
async fn fresh_legacy_migration_replaces_client_member_ids_with_server_uuids() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let processor = CrewonDomainRequestProcessor::new();

    let saved = save(
        &processor,
        &cwd,
        office_with_client_member_ids("Fresh legacy Office"),
    )
    .await;

    let member_ids = server_member_ids(&saved.config);
    assert_eq!(member_ids.len(), 3);
    assert_eq!(
        member_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        3
    );
    assert!(
        !member_ids
            .iter()
            .any(|member_id| { member_id == "client-member-a" || member_id == "client-member-b" })
    );
}

#[tokio::test]
async fn legacy_office_save_without_identity_remains_usable_after_migration() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let processor = CrewonDomainRequestProcessor::new();
    let thread_id = "legacy-office-save-thread";

    let first = save(
        &processor,
        &cwd,
        legacy_office_config("Legacy Office", thread_id, "first"),
    )
    .await;
    let second = save(
        &processor,
        &cwd,
        legacy_office_config("Legacy Office renamed", thread_id, "second"),
    )
    .await;

    assert_eq!(second.file_path, first.file_path);
    assert_eq!(
        second.config["workspace"]["recordId"],
        first.config["workspace"]["recordId"]
    );
    assert_ne!(
        second.config["workspace"]["recordRevision"],
        first.config["workspace"]["recordRevision"]
    );
    assert_eq!(second.config["workspace"]["messages"][0]["text"], "second");

    let mut stale_new_client = first.config.clone();
    stale_new_client["title"] = json!("Stale new client");
    let stale_error = processor
        .office_save(OfficeSaveParams {
            cwd: cwd.clone(),
            config: stale_new_client,
        })
        .await
        .expect_err("recordId-bearing clients must still obey CAS");
    assert_eq!(stale_error.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(
        stale_error.message,
        "office config is stale; reload the latest Office record and retry"
    );

    let mut fresh_new_client = second.config.clone();
    fresh_new_client["title"] = json!("Fresh new client");
    let third = save(&processor, &cwd, fresh_new_client).await;
    let fourth = save(
        &processor,
        &cwd,
        legacy_office_config("Legacy Office final", thread_id, "fourth"),
    )
    .await;

    assert_eq!(fourth.file_path, first.file_path);
    assert_eq!(
        fourth.config["workspace"]["recordId"],
        first.config["workspace"]["recordId"]
    );
    assert_ne!(
        fourth.config["workspace"]["recordRevision"],
        third.config["workspace"]["recordRevision"]
    );
    assert_eq!(fourth.config["title"], "Legacy Office final");
}

#[tokio::test]
async fn ordinary_save_cannot_rebind_or_reuse_a_server_owned_member_id() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let processor = CrewonDomainRequestProcessor::new();
    let initial = json!({
        "title": "Member Identity Office",
        "workspace": {
            "members": [{
                "memberId": "member-1",
                "agentId": "agent-a",
                "name": "Original Member"
            }],
            "messages": [{
                "author": "User",
                "text": "initial"
            }]
        }
    });
    let saved = save(&processor, &cwd, initial).await;
    let server_member_id = saved.config["workspace"]["members"][0]["memberId"]
        .as_str()
        .expect("server memberId")
        .to_string();
    let persisted_before = std::fs::read(&saved.file_path).expect("read original Office record");

    let mut added_without_identity = saved.config.clone();
    added_without_identity["workspace"]["members"]
        .as_array_mut()
        .expect("members array")
        .push(json!({
            "agentId": "agent-b",
            "name": "Client-added member"
        }));
    let missing_identity_error = processor
        .office_save(OfficeSaveParams {
            cwd: cwd.clone(),
            config: added_without_identity,
        })
        .await
        .expect_err("ordinary save must not add a member without server identity");
    assert_eq!(missing_identity_error.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(
        missing_identity_error.message,
        "workspace memberId values are server-owned; use office/member/add to add a member identity"
    );

    let mut rebound = saved.config.clone();
    rebound["workspace"]["members"][0]["agentId"] = json!("agent-b");
    rebound["workspace"]["members"][0]["name"] = json!("Replacement Member");
    let rebound_error = processor
        .office_save(OfficeSaveParams {
            cwd: cwd.clone(),
            config: rebound,
        })
        .await
        .expect_err("ordinary save must not rebind a memberId");

    assert_eq!(rebound_error.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(
        rebound_error.message,
        "workspace memberId cannot be rebound to another agent"
    );
    assert_eq!(
        std::fs::read(&saved.file_path).expect("reread original Office record"),
        persisted_before
    );

    let mut removed = saved.config.clone();
    removed["workspace"]["members"] = json!([]);
    let removed = save(&processor, &cwd, removed).await;
    let mut reused = removed.config.clone();
    reused["workspace"]["members"] = json!([{
        "memberId": server_member_id,
        "agentId": "agent-b",
        "name": "Reused Member"
    }]);
    let reuse_error = processor
        .office_save(OfficeSaveParams {
            cwd,
            config: reused,
        })
        .await
        .expect_err("ordinary save must not reuse a removed memberId");

    assert_eq!(reuse_error.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(
        reuse_error.message,
        "workspace memberId values are server-owned; use office/member/add to add a member identity"
    );
    let reread = read_office_record_strict(Path::new(&removed.file_path))
        .await
        .expect("read record after rejected memberId reuse")
        .expect("Office record still exists");
    assert_eq!(reread.config, removed.config);
}

#[tokio::test]
async fn ordinary_save_restores_a_unique_server_member_id_for_legacy_agent_payloads() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let processor = CrewonDomainRequestProcessor::new();
    let saved = save(
        &processor,
        &cwd,
        json!({
            "title": "Legacy member payload Office",
            "workspace": {
                "members": [{
                    "agentId": "agent-a",
                    "name": "Original member"
                }],
                "messages": []
            }
        }),
    )
    .await;
    let member_id = saved.config["workspace"]["members"][0]["memberId"]
        .as_str()
        .expect("server memberId")
        .to_string();
    let mut legacy_update = saved.config;
    legacy_update["workspace"]["members"][0]
        .as_object_mut()
        .expect("member object")
        .remove("memberId");
    legacy_update["workspace"]["members"][0]["name"] = json!("Renamed member");

    let updated = save(&processor, &cwd, legacy_update).await;

    assert_eq!(
        updated.config["workspace"]["members"][0]["memberId"],
        member_id
    );
    assert_eq!(
        updated.config["workspace"]["members"][0]["name"],
        "Renamed member"
    );
}

#[tokio::test]
async fn existing_raw_legacy_members_are_backfilled_once_during_save() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let processor = CrewonDomainRequestProcessor::new();
    let directory = super::super::domain_directory(&cwd, super::super::DomainKind::Office)
        .expect("Office directory");
    std::fs::create_dir_all(&directory).expect("create Office directory");
    let file_path = directory.join("raw-legacy-members.json");
    let legacy_config = json!({
        "title": "Raw legacy members Office",
        "workspace": {
            "recordId": "raw-legacy-members-record",
            "recordRevision": "raw-legacy-members-revision",
            "members": [
                { "agentId": "agent-a", "name": "Old agent member" },
                { "name": "Coordinator" }
            ],
            "messages": []
        }
    });
    super::super::write_domain_record(
        super::super::DomainKind::Office,
        &file_path,
        "2026-07-15T00:00:00.000Z".to_string(),
        legacy_config.clone(),
    )
    .await
    .expect("seed raw legacy Office record");
    let mut proposed = legacy_config;
    proposed["workspace"]["members"][0]["name"] = json!("Renamed agent member");

    let saved = save(&processor, &cwd, proposed).await;
    let first_ids = server_member_ids(&saved.config);
    let saved_again = save(&processor, &cwd, saved.config).await;
    let second_ids = server_member_ids(&saved_again.config);

    assert_eq!(second_ids, first_ids);
    assert_eq!(
        saved_again.config["workspace"]["members"][0]["name"],
        "Renamed agent member"
    );
}

#[tokio::test]
async fn ordinary_save_cannot_rebind_a_legacy_agent_id_member_owner() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let processor = CrewonDomainRequestProcessor::new();
    let initial = json!({
        "title": "Legacy Member Identity Office",
        "workspace": {
            "members": [{
                "memberId": "member-legacy",
                "agent_id": "agent-a",
                "name": "Legacy Member"
            }],
            "messages": []
        }
    });
    let saved = save(&processor, &cwd, initial).await;
    let mut rebound = saved.config.clone();
    rebound["workspace"]["members"][0]["agent_id"] = json!("agent-b");

    let error = processor
        .office_save(OfficeSaveParams {
            cwd,
            config: rebound,
        })
        .await
        .expect_err("ordinary save must not rebind a legacy agent_id member owner");

    assert_eq!(error.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(
        error.message,
        "workspace memberId cannot be rebound to another agent"
    );
    let reread = read_office_record_strict(Path::new(&saved.file_path))
        .await
        .expect("read record after rejected legacy owner rebind")
        .expect("Office record still exists");
    assert_eq!(reread.config, saved.config);
}

#[tokio::test]
async fn oversized_office_update_is_rejected_before_replacing_the_readable_record() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let processor = CrewonDomainRequestProcessor::new();
    let saved = save(
        &processor,
        &cwd,
        legacy_office_config("Bounded Office", "bounded-office-thread", "small"),
    )
    .await;
    let persisted_before = std::fs::read(&saved.file_path).expect("read bounded Office record");

    let mut oversized = saved.config.clone();
    oversized["workspace"]["oversizedPayload"] =
        json!("x".repeat(usize::try_from(MAX_OFFICE_RECORD_BYTES).expect("record size")));
    let error = processor
        .office_save(OfficeSaveParams {
            cwd: cwd.clone(),
            config: oversized,
        })
        .await
        .expect_err("oversized Office record must fail before replacement");

    assert_eq!(error.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(
        error.message,
        format!(
            "office config exceeds the persisted record limit of {MAX_OFFICE_RECORD_BYTES} bytes"
        )
    );
    assert_eq!(
        std::fs::read(&saved.file_path).expect("reread bounded Office record"),
        persisted_before
    );
    let reread = read_office_record_strict(Path::new(&saved.file_path))
        .await
        .expect("read record after rejected oversized update")
        .expect("bounded record still exists");
    assert_eq!(reread.config, saved.config);
}

#[tokio::test]
async fn persisted_office_record_limit_includes_the_envelope_and_trailing_newline() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let exact_path = temp_dir.path().join("exact-limit.json");
    let oversized_path = temp_dir.path().join("over-limit.json");
    let saved_at = "2026-07-14T00:00:00.000Z";
    let mut config = json!({
        "title": "Exact limit Office",
        "workspace": {
            "recordId": "exact-limit-record",
            "recordRevision": "exact-limit-revision",
            "payload": ""
        }
    });
    let empty_record = json!({
        "version": 1,
        "kind": "office",
        "savedAt": saved_at,
        "config": config
    });
    let empty_size = serde_json::to_vec_pretty(&empty_record)
        .expect("serialize empty Office envelope")
        .len()
        .saturating_add(1);
    let limit = usize::try_from(MAX_OFFICE_RECORD_BYTES).expect("record size");
    config["workspace"]["payload"] = json!("x".repeat(limit - empty_size));

    super::super::write_domain_record(
        super::super::DomainKind::Office,
        &exact_path,
        saved_at.to_string(),
        config.clone(),
    )
    .await
    .expect("the exact persisted byte limit must remain writable");
    assert_eq!(
        std::fs::metadata(&exact_path)
            .expect("exact-limit metadata")
            .len(),
        MAX_OFFICE_RECORD_BYTES
    );

    config["workspace"]["payload"] = json!("x".repeat(limit - empty_size + 1));
    let error = super::super::write_domain_record(
        super::super::DomainKind::Office,
        &oversized_path,
        saved_at.to_string(),
        config,
    )
    .await
    .expect_err("one byte beyond the persisted limit must fail");
    assert_eq!(error.code, INVALID_PARAMS_ERROR_CODE);
    assert!(!oversized_path.exists());
}

#[tokio::test]
async fn unrelated_unreadable_records_do_not_block_save_or_message_submit() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let processor = CrewonDomainRequestProcessor::new();
    let saved = save(
        &processor,
        &cwd,
        legacy_office_config("Healthy Office", "healthy-office-thread", "first"),
    )
    .await;
    let office_directory = PathBuf::from(&saved.file_path)
        .parent()
        .expect("Office directory")
        .to_path_buf();
    std::fs::write(office_directory.join("corrupt-neighbor.json"), b"{not json")
        .expect("write corrupt neighbor");
    std::fs::write(
        office_directory.join("oversized-neighbor.json"),
        vec![b'x'; usize::try_from(MAX_OFFICE_RECORD_BYTES + 1).expect("oversized length")],
    )
    .expect("write oversized neighbor");

    let mut updated = saved.config.clone();
    updated["workspace"]["messages"][0]["text"] = json!("saved around bad neighbors");
    let saved_again = save(&processor, &cwd, updated).await;
    let prepared = processor
        .office_message_submit_prepare(OfficeMessageSubmitParams {
            cwd: cwd.clone(),
            config: saved_again.config,
            text: "submitted around bad neighbors".to_string(),
            client_user_message_id: "bad-neighbor-submit".to_string(),
            locale: None,
            thread_id: Some("healthy-office-thread".to_string()),
            mentions: None,
        })
        .await
        .expect("message submit must isolate unrelated unreadable records");

    assert_eq!(
        prepared.config["workspace"]["recordId"],
        saved.config["workspace"]["recordId"]
    );
    assert_eq!(prepared.text, "submitted around bad neighbors");
    assert_eq!(prepared.message["text"], "submitted around bad neighbors");
    let (scheduled, next_cursor) = list_office_records_for_scheduler(&cwd, None, /*limit*/ 24)
        .await
        .expect("scheduler list must isolate unreadable records");
    assert_eq!(next_cursor, None);
    assert_eq!(scheduled.len(), 1);
    assert_eq!(scheduled[0].file_path, saved.file_path);
}

#[tokio::test]
async fn unreadable_legacy_neighbors_do_not_block_the_first_healthy_save() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let office_directory = temp_dir.path().join(".crewon").join("offices");
    std::fs::create_dir_all(&office_directory).expect("create Office directory");
    std::fs::write(office_directory.join("corrupt-legacy.json"), b"{not json")
        .expect("write corrupt legacy neighbor");
    std::fs::write(
        office_directory.join("oversized-legacy.json"),
        vec![b'x'; usize::try_from(MAX_OFFICE_RECORD_BYTES + 1).expect("oversized length")],
    )
    .expect("write oversized legacy neighbor");

    let processor = CrewonDomainRequestProcessor::new();
    let saved = save(
        &processor,
        &cwd,
        legacy_office_config("First Healthy Office", "first-healthy-thread", "first"),
    )
    .await;
    let mut update = saved.config.clone();
    update["workspace"]["messages"][0]["text"] = json!("second");
    let saved_again = save(&processor, &cwd, update).await;

    assert_eq!(saved_again.file_path, saved.file_path);
    assert_eq!(
        saved_again.config["workspace"]["messages"][0]["text"],
        "second"
    );

    let authority = super::super::office_authority_lock::lock(&cwd)
        .await
        .expect("lock Office authority");
    let mut runtime_owners = super::super::office_runtime_owner_registry::load(&cwd, &authority)
        .await
        .expect("load quarantined runtime owner registry");
    let claim_error = runtime_owners
        .claim_pending(
            "replacement-runtime",
            saved.config["workspace"]["recordId"]
                .as_str()
                .expect("record id"),
            "agent-a",
            "missing-runtime",
        )
        .await
        .expect_err("new runtime owner claims must fail while unreadable records are quarantined");
    assert_eq!(claim_error.code, INTERNAL_ERROR_CODE);
    assert_eq!(
        claim_error.message,
        "Office runtime owner claims are disabled while unreadable Office records are quarantined"
    );

    std::fs::remove_file(office_directory.join("corrupt-legacy.json"))
        .expect("remove corrupt legacy neighbor");
    std::fs::remove_file(office_directory.join("oversized-legacy.json"))
        .expect("remove oversized legacy neighbor");
    super::super::office_runtime_owner_reconciliation::reconcile_if_needed(
        &office_directory,
        &mut runtime_owners,
    )
    .await
    .expect("complete reconciliation after quarantined records are removed");
    let claim = runtime_owners
        .claim_pending(
            "replacement-runtime",
            saved.config["workspace"]["recordId"]
                .as_str()
                .expect("record id"),
            "agent-a",
            "missing-runtime",
        )
        .await
        .expect("runtime owner claims resume after quarantine clears");
    runtime_owners
        .remove_pending(&claim)
        .await
        .expect("remove test runtime owner claim");
}

#[tokio::test]
async fn target_corruption_or_oversize_still_fails_closed() {
    for target_contents in [
        b"{not json".to_vec(),
        vec![b'x'; usize::try_from(MAX_OFFICE_RECORD_BYTES + 1).expect("oversized length")],
    ] {
        let temp_dir = TempDir::new().expect("create temp dir");
        let cwd = temp_dir.path().to_string_lossy().into_owned();
        let processor = CrewonDomainRequestProcessor::new();
        let saved = save(
            &processor,
            &cwd,
            legacy_office_config("Target Office", "target-office-thread", "first"),
        )
        .await;
        std::fs::write(&saved.file_path, target_contents).expect("damage target Office record");

        let error = processor
            .office_save(OfficeSaveParams {
                cwd: cwd.clone(),
                config: legacy_office_config(
                    "Target Office renamed",
                    "target-office-thread",
                    "second",
                ),
            })
            .await
            .expect_err("damaged target identity must fail closed");
        assert_eq!(error.code, INTERNAL_ERROR_CODE);
        assert!(error.message.contains("failed to resolve Office identity"));

        let read_error = processor
            .office_read(OfficeReadParams {
                cwd: cwd.clone(),
                thread_id: Some("target-office-thread".to_string()),
                title: None,
            })
            .await
            .expect_err("targeted Office read must fail closed for a damaged record");
        assert_eq!(read_error.code, INTERNAL_ERROR_CODE);

        let saved_path = PathBuf::from(&saved.file_path);
        let directory = saved_path.parent().expect("Office directory");
        let lookup_error = find_office_record(
            directory,
            OfficeIdentityLookup::RecordId(
                saved.config["workspace"]["recordId"]
                    .as_str()
                    .expect("record id"),
            ),
        )
        .await
        .expect_err("direct target lookup must fail closed");
        assert_eq!(lookup_error.code, INTERNAL_ERROR_CODE);
    }
}

#[tokio::test]
async fn duplicate_target_identity_still_fails_closed() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let processor = CrewonDomainRequestProcessor::new();
    let saved = save(
        &processor,
        &cwd,
        legacy_office_config("Duplicate Office", "duplicate-office-thread", "first"),
    )
    .await;
    let duplicate_path = PathBuf::from(&saved.file_path).with_file_name("duplicate-target.json");
    std::fs::copy(&saved.file_path, duplicate_path).expect("duplicate target record");

    let mut update = saved.config;
    update["title"] = json!("Duplicate Office renamed");
    let error = processor
        .office_save(OfficeSaveParams {
            cwd,
            config: update,
        })
        .await
        .expect_err("duplicate target recordId must fail closed");

    assert_eq!(error.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(
        error.message,
        "multiple office configs match the same workspace.recordId"
    );
}
