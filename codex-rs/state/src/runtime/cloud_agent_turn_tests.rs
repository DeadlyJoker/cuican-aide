use pretty_assertions::assert_eq;

use super::StateRuntime;
use crate::CloudAgentTurnCreateBundle;
use crate::CloudAgentTurnCreateOutcome;
use crate::DurableWorkspaceRootResolveOutcome;
use crate::ProviderAccessGrantRecord;
use crate::ProviderAccessGrantResolveOutcome;
use crate::ProviderAccessGrantRevokeOutcome;
use crate::ProviderAccessGrantRevokeRequest;
use crate::ProviderAccessGrantStatus;
use crate::ProviderConnectionResolveOutcome;
use crate::ProviderIdentityBindingCreateOutcome;
use crate::ProviderIdentityBindingRecord;
use crate::ProviderIdentityBindingStatus;
use crate::ProviderResourceBindingResolveOutcome;
use crate::ProviderResourceWorkspaceScope;
use crate::ThreadExecutionContextBindingUpdate;
use crate::ThreadExecutionContextCreateOutcome;
use crate::cloud_agent_turn_records_tests::create_bundle;
use crate::durable_workspace_records_tests::root_record;
use crate::provider_connection_records_tests::connection_record;
use crate::provider_resource_binding_records_tests::binding_record;
use crate::runtime::test_support::unique_temp_dir;
use crate::thread_execution_context_records_tests::context_record;

const HASH_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACTOR_ID: &str = "principal:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GRANT_ID: &str = "provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c102";
const SOURCE_BINDING_ID: &str = "018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c103";

#[tokio::test]
async fn atomic_cloud_agent_turn_is_idempotent_restart_durable_and_locks_binding() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let (context, binding) = seed_authority(&runtime).await;
    seed_prompt_artifact(&runtime).await;
    let bundle = runtime_bundle(&context, &binding);

    assert_eq!(
        runtime
            .create_cloud_agent_turn_bundle(&bundle, /*authorized_at*/ 100)
            .await
            .expect("create atomic Cloud Agent Turn"),
        CloudAgentTurnCreateOutcome::Created(bundle.turn.clone())
    );
    assert_eq!(
        runtime
            .create_cloud_agent_turn_bundle(&bundle, /*authorized_at*/ 100)
            .await
            .expect("repeat atomic Cloud Agent Turn"),
        CloudAgentTurnCreateOutcome::ExistingSame(bundle.turn.clone())
    );
    assert_eq!(
        runtime
            .get_cloud_agent_turn_record(&bundle.turn.turn_id)
            .await
            .expect("read Cloud Agent Turn by id"),
        Some(bundle.turn.clone())
    );
    assert_eq!(
        runtime
            .get_cloud_agent_turn_record_by_client_message(
                &bundle.turn.thread_id,
                &bundle.turn.client_user_message_id,
            )
            .await
            .expect("read Cloud Agent Turn by client identity"),
        Some(bundle.turn.clone())
    );
    let task = runtime
        .get_task_record("task-1")
        .await
        .expect("read accepted Task")
        .expect("accepted Task exists");
    assert_eq!(task.status, "queued");
    assert_eq!(task.aggregate_version, 1);
    assert_eq!(task.stream_offset, 1);
    assert_eq!(
        runtime
            .get_cloud_execution_spec_record("execution-spec-1", /*revision*/ 1)
            .await
            .expect("read execution spec"),
        Some(bundle.execution_spec.clone())
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM task_runtime_events WHERE task_id = 'task-1'",
        )
        .fetch_one(runtime.pool.as_ref())
        .await
        .expect("count Task events"),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM task_runtime_outbox WHERE task_id = 'task-1'",
        )
        .fetch_one(runtime.pool.as_ref())
        .await
        .expect("count Task outbox"),
        1
    );

    let clear_binding = ThreadExecutionContextBindingUpdate {
        thread_id: context.thread_id.clone(),
        local_actor_id: context.local_actor_id.clone(),
        local_tenant_id: context.local_tenant_id.clone(),
        local_space_id: context.local_space_id.clone(),
        expected_revision: context.revision,
        resource_bindings: Vec::new(),
        execution_binding: None,
        updated_at: 102,
    };
    runtime
        .update_thread_execution_context_bindings(&clear_binding)
        .await
        .expect_err("durable Cloud Task must lock exact execution binding");

    let mut changed = bundle.clone();
    changed.accepted_commit.outbox[0].payload_json =
        r#"{"attemptId":"attempt-changed","type":"enqueueAttempt"}"#.to_string();
    changed.turn.creation_digest = changed.canonical_digest();
    changed.turn.record_hash = changed.turn.canonical_hash();
    assert_eq!(
        runtime
            .create_cloud_agent_turn_bundle(&changed, /*authorized_at*/ 100)
            .await
            .expect("reject changed client replay"),
        CloudAgentTurnCreateOutcome::Conflict
    );

    let second = reidentify_bundle(bundle.clone(), "2");
    assert_eq!(
        runtime
            .create_cloud_agent_turn_bundle(&second, /*authorized_at*/ 100)
            .await
            .expect("reject concurrent active Turn"),
        CloudAgentTurnCreateOutcome::ActiveTurnExists
    );

    runtime.close().await;
    let reopened = initialized(&codex_home).await;
    assert_eq!(
        reopened
            .get_cloud_agent_turn_record(&bundle.turn.turn_id)
            .await
            .expect("read restarted Cloud Agent Turn"),
        Some(bundle.turn)
    );
    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn late_insert_failure_rolls_back_task_event_outbox_spec_and_turn() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let (context, binding) = seed_authority(&runtime).await;
    seed_prompt_artifact(&runtime).await;
    let bundle = runtime_bundle(&context, &binding);
    sqlx::query(
        r#"
CREATE TRIGGER fail_cloud_agent_turn_insert
BEFORE INSERT ON cloud_agent_turns
BEGIN
    SELECT RAISE(ABORT, 'injected Cloud Agent Turn failure');
END
        "#,
    )
    .execute(runtime.pool.as_ref())
    .await
    .expect("install failure injection");

    runtime
        .create_cloud_agent_turn_bundle(&bundle, /*authorized_at*/ 100)
        .await
        .expect_err("injected late failure must abort transaction");
    for (table, query) in [
        (
            "task_runtime_tasks",
            "SELECT COUNT(*) FROM task_runtime_tasks",
        ),
        (
            "task_runtime_events",
            "SELECT COUNT(*) FROM task_runtime_events",
        ),
        (
            "task_runtime_inbox",
            "SELECT COUNT(*) FROM task_runtime_inbox",
        ),
        (
            "task_runtime_outbox",
            "SELECT COUNT(*) FROM task_runtime_outbox",
        ),
        (
            "cloud_execution_specs",
            "SELECT COUNT(*) FROM cloud_execution_specs",
        ),
        (
            "cloud_agent_turns",
            "SELECT COUNT(*) FROM cloud_agent_turns",
        ),
        (
            "cloud_agent_thread_summaries",
            "SELECT COUNT(*) FROM cloud_agent_thread_summaries",
        ),
    ] {
        let count: i64 = sqlx::query_scalar(query)
            .fetch_one(runtime.pool.as_ref())
            .await
            .expect("count rolled back table");
        assert_eq!(count, 0, "{table} must be empty after rollback");
    }

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn atomic_create_revalidates_revoked_authority_before_duplicate_response() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let (context, binding) = seed_authority(&runtime).await;
    seed_prompt_artifact(&runtime).await;
    let bundle = runtime_bundle(&context, &binding);
    assert_eq!(
        runtime
            .create_cloud_agent_turn_bundle(&bundle, /*authorized_at*/ 100)
            .await
            .expect("create Cloud Agent Turn"),
        CloudAgentTurnCreateOutcome::Created(bundle.turn.clone())
    );
    assert_eq!(
        runtime
            .revoke_provider_access_grant_record(&ProviderAccessGrantRevokeRequest {
                grant_id: GRANT_ID.to_string(),
                expected_revision: 1,
                revoked_at: 101,
            })
            .await
            .expect("revoke Provider grant"),
        ProviderAccessGrantRevokeOutcome::Revoked
    );
    assert_eq!(
        runtime
            .create_cloud_agent_turn_bundle(&bundle, /*authorized_at*/ 102)
            .await
            .expect("revalidate duplicate authority"),
        CloudAgentTurnCreateOutcome::DependencyMissing
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

pub(super) async fn seed_authority(
    runtime: &StateRuntime,
) -> (
    crate::ThreadExecutionContextRecord,
    crate::ProviderResourceBindingRecord,
) {
    let root = root_record(
        "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001",
        &format!("sha256:{}", "c".repeat(64)),
    );
    assert_eq!(
        runtime
            .resolve_durable_workspace_root_record(&root)
            .await
            .expect("create durable workspace"),
        DurableWorkspaceRootResolveOutcome::Created(root)
    );
    let mut identity = ProviderIdentityBindingRecord {
        binding_id: "identity-binding-cloud-agent".to_string(),
        local_actor_id: ACTOR_ID.to_string(),
        local_tenant_id: "tenant-1".to_string(),
        local_space_id: "space-1".to_string(),
        provider_id: "agent-platform".to_string(),
        provider_subject: "user:42".to_string(),
        provider_tenant_id: "7".to_string(),
        provider_space_id: "11".to_string(),
        authority_id: "authority-1".to_string(),
        source_binding_id: SOURCE_BINDING_ID.to_string(),
        source_revision: 1,
        source_fresh_until: 1_000,
        revision: 1,
        status: ProviderIdentityBindingStatus::Active,
        record_hash: String::new(),
        created_at: 100,
        updated_at: 100,
    };
    identity.record_hash = identity.canonical_hash();
    assert_eq!(
        runtime
            .create_provider_identity_binding_record(&identity)
            .await
            .expect("create Provider identity"),
        ProviderIdentityBindingCreateOutcome::Created
    );
    let mut grant = ProviderAccessGrantRecord {
        grant_id: GRANT_ID.to_string(),
        local_actor_id: ACTOR_ID.to_string(),
        local_tenant_id: "tenant-1".to_string(),
        local_space_id: "space-1".to_string(),
        provider_id: "agent-platform".to_string(),
        source_binding_id: SOURCE_BINDING_ID.to_string(),
        source_revision: 1,
        granted_scopes: vec!["runs:start".to_string()],
        status: ProviderAccessGrantStatus::Active,
        expires_at: 1_000,
        revision: 1,
        record_hash: String::new(),
        created_at: 100,
        updated_at: 100,
        revoked_at: None,
    };
    grant.record_hash = grant.canonical_hash();
    assert_eq!(
        runtime
            .resolve_provider_access_grant_record(&grant)
            .await
            .expect("create Provider grant"),
        ProviderAccessGrantResolveOutcome::Created(grant)
    );
    let mut connection =
        connection_record("provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101");
    connection.credential_id = GRANT_ID.to_string();
    connection.credential_revision = 1;
    connection.local_actor_id = ACTOR_ID.to_string();
    connection.record_hash = connection.canonical_hash();
    assert_eq!(
        runtime
            .resolve_provider_connection_record(&connection)
            .await
            .expect("create Provider connection"),
        ProviderConnectionResolveOutcome::Created(connection)
    );
    let mut binding = binding_record("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c401");
    binding.workspace_scope = ProviderResourceWorkspaceScope::Conversation;
    binding.workspace_scope_id = "019f550e-ba52-7490-a248-b0d3a84103c1".to_string();
    binding.local_actor_id = ACTOR_ID.to_string();
    binding.record_hash = binding.canonical_hash();
    assert!(matches!(
        runtime
            .resolve_provider_resource_binding_record(&binding)
            .await
            .expect("create Provider Agent binding"),
        ProviderResourceBindingResolveOutcome::Created(_)
    ));
    let mut context = context_record();
    context.local_actor_id = ACTOR_ID.to_string();
    context.execution_binding = Some(context.resource_bindings[0].clone());
    context.record_hash = context.canonical_hash();
    assert_eq!(
        runtime
            .create_thread_execution_context_record(&context)
            .await
            .expect("create execution-bound Thread context"),
        ThreadExecutionContextCreateOutcome::Created
    );
    (context, binding)
}

pub(super) async fn seed_prompt_artifact(runtime: &StateRuntime) {
    sqlx::query(
        r#"
INSERT INTO artifact_payloads (
    payload_id, sha256, byte_len, media_type, sensitivity, retention_kind,
    expires_at, status, content, created_at
) VALUES (
    'payload-prompt-artifact', ?, 1, 'text/plain', 'internal',
    'user_managed', NULL, 'available', X'78', 100
)
        "#,
    )
    .bind(HASH_A)
    .execute(runtime.pool.as_ref())
    .await
    .expect("seed prompt payload");
    sqlx::query(
        r#"
INSERT INTO artifact_manifests (
    artifact_id, revision, idempotency_key, commit_hash,
    payload_id, manifest_json, created_at
) VALUES (
    'prompt-artifact', 1, 'prompt-idempotency', ?,
    'payload-prompt-artifact', '{}', 100
)
        "#,
    )
    .bind(HASH_A)
    .execute(runtime.pool.as_ref())
    .await
    .expect("seed prompt manifest");
}

pub(super) fn runtime_bundle(
    context: &crate::ThreadExecutionContextRecord,
    binding: &crate::ProviderResourceBindingRecord,
) -> CloudAgentTurnCreateBundle {
    let mut bundle = create_bundle();
    bundle.turn.thread_id.clone_from(&context.thread_id);
    bundle
        .turn
        .local_actor_id
        .clone_from(&context.local_actor_id);
    bundle
        .turn
        .local_tenant_id
        .clone_from(&context.local_tenant_id);
    bundle
        .turn
        .local_space_id
        .clone_from(&context.local_space_id);
    bundle.turn.workspace_key.clone_from(&context.workspace_key);
    bundle.turn.execution_binding = context
        .execution_binding
        .clone()
        .expect("execution binding");
    bundle
        .execution_spec
        .workspace_key
        .clone_from(&context.workspace_key);
    bundle
        .execution_spec
        .binding_id
        .clone_from(&binding.binding_id);
    bundle
        .execution_spec
        .provider_id
        .clone_from(&binding.provider_id);
    bundle
        .execution_spec
        .protocol_version
        .clone_from(&binding.protocol_version);
    bundle.execution_spec.resource_kind = binding.resource_kind.as_str().to_string();
    bundle
        .execution_spec
        .resource_id
        .clone_from(&binding.resource_id);
    bundle
        .execution_spec
        .resource_revision
        .clone_from(&binding.resource_revision);
    bundle.execution_spec.credential_id = GRANT_ID.to_string();
    bundle.execution_spec.credential_revision = 1;
    bundle.execution_spec.digest = bundle.execution_spec.canonical_digest();
    bundle.turn.creation_digest = bundle.canonical_digest();
    bundle.turn.record_hash = bundle.turn.canonical_hash();
    bundle.validate().expect("runtime bundle");
    bundle
}

pub(super) fn reidentify_bundle(
    mut bundle: CloudAgentTurnCreateBundle,
    suffix: &str,
) -> CloudAgentTurnCreateBundle {
    let task_id = format!("task-{suffix}");
    bundle.task_genesis.task_id.clone_from(&task_id);
    bundle.accepted_commit.task_id.clone_from(&task_id);
    bundle.accepted_commit.snapshot.task_id.clone_from(&task_id);
    bundle.accepted_commit.event.task_id.clone_from(&task_id);
    bundle
        .accepted_commit
        .attempt
        .as_mut()
        .expect("attempt")
        .task_id
        .clone_from(&task_id);
    bundle.execution_spec.task_id.clone_from(&task_id);
    bundle.turn.origin = crate::CloudAgentTurnOrigin::DurableTask { task_id };
    bundle.turn.turn_id = format!("turn-{suffix}");
    bundle.turn.client_user_message_id = format!("client-message-{suffix}");
    bundle.execution_spec.execution_spec_id = format!("execution-spec-{suffix}");
    bundle.execution_spec.digest = bundle.execution_spec.canonical_digest();
    bundle.accepted_commit.outbox[0].outbox_id = format!("outbox-enqueue-{suffix}");
    bundle.turn.creation_digest = bundle.canonical_digest();
    bundle.turn.record_hash = bundle.turn.canonical_hash();
    bundle.validate().expect("reidentified bundle");
    bundle
}

pub(super) async fn initialized(codex_home: &std::path::Path) -> std::sync::Arc<StateRuntime> {
    StateRuntime::init(codex_home.to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize State")
}
