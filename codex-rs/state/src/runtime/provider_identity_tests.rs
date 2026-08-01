use pretty_assertions::assert_eq;

use super::StateRuntime;
use crate::ProviderIdentityBindingCreateOutcome;
use crate::ProviderIdentityBindingLookup;
use crate::ProviderIdentityBindingRefreshOutcome;
use crate::ProviderIdentityBindingRefreshRequest;
use crate::ProviderIdentityBindingRevokeOutcome;
use crate::ProviderIdentityBindingRevokeRequest;
use crate::ProviderIdentityBindingStatus;
use crate::provider_identity_records_tests::binding;
use crate::runtime::test_support::unique_temp_dir;

#[tokio::test]
async fn provider_identity_binding_round_trips_across_reopen_and_enforces_active_uniqueness() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let record = binding("identity-binding-1");
    assert_eq!(
        runtime
            .create_provider_identity_binding_record(&record)
            .await
            .expect("create binding"),
        ProviderIdentityBindingCreateOutcome::Created
    );
    assert_eq!(
        runtime
            .create_provider_identity_binding_record(&record)
            .await
            .expect("replay binding"),
        ProviderIdentityBindingCreateOutcome::ExistingSame
    );

    let mut owner_conflict = binding("identity-binding-2");
    owner_conflict.provider_subject = "user:43".to_string();
    owner_conflict.source_binding_id = "identity-source-binding-2".to_string();
    owner_conflict.record_hash = owner_conflict.canonical_hash();
    assert_eq!(
        runtime
            .create_provider_identity_binding_record(&owner_conflict)
            .await
            .expect("owner conflict"),
        ProviderIdentityBindingCreateOutcome::Conflict
    );

    let mut target_conflict = binding("identity-binding-3");
    target_conflict.local_actor_id = format!("principal:{}", "b".repeat(64));
    target_conflict.source_binding_id = "identity-source-binding-3".to_string();
    target_conflict.record_hash = target_conflict.canonical_hash();
    assert_eq!(
        runtime
            .create_provider_identity_binding_record(&target_conflict)
            .await
            .expect("target conflict"),
        ProviderIdentityBindingCreateOutcome::Conflict
    );
    runtime.close().await;

    let reopened = initialized(&codex_home).await;
    assert_eq!(
        reopened
            .get_active_provider_identity_binding_record(&lookup(), 150)
            .await
            .expect("read active binding"),
        Some(record)
    );
    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn provider_identity_revoke_is_terminal_cas_idempotent_and_allows_new_binding() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let record = binding("identity-binding-1");
    runtime
        .create_provider_identity_binding_record(&record)
        .await
        .expect("create binding");
    let revoke = ProviderIdentityBindingRevokeRequest {
        binding_id: record.binding_id.clone(),
        expected_revision: 1,
        authority_id: record.authority_id.clone(),
        source_revision: 2,
        source_fresh_until: 161,
        updated_at: 101,
    };
    assert_eq!(
        runtime
            .revoke_provider_identity_binding_record(&revoke)
            .await
            .expect("revoke binding"),
        ProviderIdentityBindingRevokeOutcome::Revoked
    );
    assert_eq!(
        runtime
            .revoke_provider_identity_binding_record(&revoke)
            .await
            .expect("replay revoke"),
        ProviderIdentityBindingRevokeOutcome::ExistingRevoked
    );
    let mut stale = revoke;
    stale.source_revision = 3;
    stale.updated_at = 102;
    assert_eq!(
        runtime
            .revoke_provider_identity_binding_record(&stale)
            .await
            .expect("terminal revoke"),
        ProviderIdentityBindingRevokeOutcome::Conflict
    );
    assert_eq!(
        runtime
            .get_active_provider_identity_binding_record(&lookup(), 150)
            .await
            .expect("read active binding"),
        None
    );
    let revoked = runtime
        .get_provider_identity_binding_record("identity-binding-1")
        .await
        .expect("read revoked binding")
        .expect("revoked binding");
    let mut expected_revoked = record.clone();
    expected_revoked.source_revision = 2;
    expected_revoked.source_fresh_until = 161;
    expected_revoked.revision = 2;
    expected_revoked.status = ProviderIdentityBindingStatus::Revoked;
    expected_revoked.updated_at = 101;
    expected_revoked.record_hash = expected_revoked.canonical_hash();
    assert_eq!(revoked, expected_revoked);

    let mut reused_source = binding("identity-binding-reused-source");
    reused_source.local_actor_id = format!("principal:{}", "b".repeat(64));
    reused_source.provider_subject = "user:43".to_string();
    reused_source.source_revision = 1;
    reused_source.created_at = 102;
    reused_source.updated_at = 102;
    reused_source.record_hash = reused_source.canonical_hash();
    assert_eq!(
        runtime
            .create_provider_identity_binding_record(&reused_source)
            .await
            .expect("reused source binding"),
        ProviderIdentityBindingCreateOutcome::Conflict
    );

    let mut replacement = binding("identity-binding-2");
    replacement.source_binding_id = "identity-source-binding-2".to_string();
    replacement.source_revision = 1;
    replacement.created_at = 102;
    replacement.updated_at = 102;
    replacement.record_hash = replacement.canonical_hash();
    assert_eq!(
        runtime
            .create_provider_identity_binding_record(&replacement)
            .await
            .expect("replacement binding"),
        ProviderIdentityBindingCreateOutcome::Created
    );
    runtime.close().await;

    let reopened = initialized(&codex_home).await;
    assert_eq!(
        reopened
            .get_provider_identity_binding_record("identity-binding-1")
            .await
            .expect("read reopened revoked binding"),
        Some(expected_revoked)
    );
    assert_eq!(
        reopened
            .get_active_provider_identity_binding_record(&lookup(), 150)
            .await
            .expect("read reopened replacement binding"),
        Some(replacement)
    );
    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn concurrent_provider_identity_binding_creation_has_one_active_winner() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let first = binding("identity-binding-concurrent-1");
    let mut second = binding("identity-binding-concurrent-2");
    second.provider_subject = "user:43".to_string();
    second.source_binding_id = "identity-source-binding-concurrent-2".to_string();
    second.record_hash = second.canonical_hash();

    let first_create = runtime.create_provider_identity_binding_record(&first);
    let second_create = runtime.create_provider_identity_binding_record(&second);
    let (first_outcome, second_outcome) = tokio::join!(first_create, second_create);
    let outcomes = (
        first_outcome.expect("first concurrent create"),
        second_outcome.expect("second concurrent create"),
    );
    assert!(matches!(
        outcomes,
        (
            ProviderIdentityBindingCreateOutcome::Created,
            ProviderIdentityBindingCreateOutcome::Conflict
        ) | (
            ProviderIdentityBindingCreateOutcome::Conflict,
            ProviderIdentityBindingCreateOutcome::Created
        )
    ));

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn provider_identity_freshness_is_cas_refreshed_and_stale_records_fail_closed() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let record = binding("identity-binding-freshness");
    runtime
        .create_provider_identity_binding_record(&record)
        .await
        .expect("create binding");
    assert_eq!(
        runtime
            .get_active_provider_identity_binding_record(&lookup(), 200)
            .await
            .expect("stale lookup"),
        None
    );

    let refresh = ProviderIdentityBindingRefreshRequest {
        binding_id: record.binding_id.clone(),
        expected_revision: record.revision,
        authority_id: record.authority_id.clone(),
        source_binding_id: record.source_binding_id.clone(),
        source_revision: record.source_revision,
        source_fresh_until: 260,
    };
    assert_eq!(
        runtime
            .refresh_provider_identity_binding_record(&refresh)
            .await
            .expect("refresh binding"),
        ProviderIdentityBindingRefreshOutcome::Refreshed
    );
    assert_eq!(
        runtime
            .refresh_provider_identity_binding_record(&refresh)
            .await
            .expect("replay refresh"),
        ProviderIdentityBindingRefreshOutcome::ExistingFresh
    );
    let refreshed = runtime
        .get_active_provider_identity_binding_record(&lookup(), 250)
        .await
        .expect("fresh lookup")
        .expect("fresh binding");
    assert_eq!(refreshed.revision, 2);
    assert_eq!(refreshed.source_fresh_until, 260);

    let mut regressed = refresh;
    regressed.expected_revision = refreshed.revision;
    regressed.source_fresh_until = 240;
    assert_eq!(
        runtime
            .refresh_provider_identity_binding_record(&regressed)
            .await
            .expect("regressed refresh"),
        ProviderIdentityBindingRefreshOutcome::Conflict
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn active_provider_identity_listing_is_cursor_bounded() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let first = binding("identity-binding-page-1");
    let mut second = binding("identity-binding-page-2");
    second.local_actor_id = format!("principal:{}", "b".repeat(64));
    second.provider_subject = "user:43".to_string();
    second.source_binding_id = "identity-source-binding-page-2".to_string();
    second.record_hash = second.canonical_hash();
    for record in [&first, &second] {
        assert_eq!(
            runtime
                .create_provider_identity_binding_record(record)
                .await
                .expect("create paged binding"),
            ProviderIdentityBindingCreateOutcome::Created
        );
    }

    let first_page = runtime
        .list_active_provider_identity_binding_records(None, /*limit*/ 1)
        .await
        .expect("first page");
    assert_eq!(first_page.data, vec![first]);
    assert_eq!(
        first_page.next_cursor,
        Some("identity-binding-page-1".to_string())
    );
    let second_page = runtime
        .list_active_provider_identity_binding_records(
            first_page.next_cursor.as_deref(),
            /*limit*/ 1,
        )
        .await
        .expect("second page");
    assert_eq!(second_page.data, vec![second]);
    assert_eq!(second_page.next_cursor, None);

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

fn lookup() -> ProviderIdentityBindingLookup {
    ProviderIdentityBindingLookup {
        local_actor_id: format!("principal:{}", "a".repeat(64)),
        local_tenant_id: "tenant-local-1".to_string(),
        local_space_id: "space-local-1".to_string(),
        provider_id: "agent-platform".to_string(),
    }
}

async fn initialized(codex_home: &std::path::Path) -> std::sync::Arc<StateRuntime> {
    StateRuntime::init(codex_home.to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize state")
}
