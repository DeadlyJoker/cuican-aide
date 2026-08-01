use crewon_protocol::ThreadId;
use pretty_assertions::assert_eq;

use super::StateRuntime;
use crate::DurableWorkspaceRootResolveOutcome;
use crate::ProviderConnectionResolveOutcome;
use crate::ProviderResourceBindingResolveOutcome;
use crate::ProviderResourceBindingUnbindOutcome;
use crate::ProviderResourceBindingUnbindRequest;
use crate::ProviderResourceKind;
use crate::ProviderResourceWorkspaceScope;
use crate::ThreadExecutionContextBindingUpdate;
use crate::ThreadExecutionContextCreateOutcome;
use crate::ThreadExecutionContextUpdateOutcome;
use crate::durable_workspace_records_tests::root_record;
use crate::provider_connection_records_tests::connection_record;
use crate::provider_resource_binding_records_tests::binding_record;
use crate::runtime::test_support::unique_temp_dir;
use crate::thread_execution_context_records_tests::context_record;

#[tokio::test]
async fn thread_execution_context_is_owner_scoped_exact_and_restart_durable() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    seed_parents(&runtime).await;
    let binding = conversation_binding();
    assert!(matches!(
        runtime
            .resolve_provider_resource_binding_record(&binding)
            .await
            .expect("create Provider resource binding"),
        ProviderResourceBindingResolveOutcome::Created(_)
    ));
    let context = context_record();
    assert_eq!(
        runtime
            .create_thread_execution_context_record(&context)
            .await
            .expect("create Thread execution context"),
        ThreadExecutionContextCreateOutcome::Created
    );
    assert_eq!(
        runtime
            .create_thread_execution_context_record(&context)
            .await
            .expect("replay Thread execution context"),
        ThreadExecutionContextCreateOutcome::ExistingSame
    );

    let update = ThreadExecutionContextBindingUpdate {
        thread_id: context.thread_id.clone(),
        local_actor_id: context.local_actor_id.clone(),
        local_tenant_id: context.local_tenant_id.clone(),
        local_space_id: context.local_space_id.clone(),
        expected_revision: 1,
        resource_bindings: Vec::new(),
        execution_binding: None,
        updated_at: 110,
    };
    assert_eq!(
        runtime
            .update_thread_execution_context_bindings(&update)
            .await
            .expect("clear Thread bindings"),
        ThreadExecutionContextUpdateOutcome::Updated
    );
    assert_eq!(
        runtime
            .update_thread_execution_context_bindings(&update)
            .await
            .expect("replay Thread binding update"),
        ThreadExecutionContextUpdateOutcome::ExistingSame
    );
    let mut cross_owner = update.clone();
    cross_owner.local_actor_id = "actor-other".to_string();
    cross_owner.expected_revision = 2;
    cross_owner.updated_at = 120;
    assert_eq!(
        runtime
            .update_thread_execution_context_bindings(&cross_owner)
            .await
            .expect("cross-owner update"),
        ThreadExecutionContextUpdateOutcome::NotFound
    );
    let updated = runtime
        .get_thread_execution_context_record(&context.thread_id)
        .await
        .expect("read Thread execution context")
        .expect("Thread execution context exists");
    assert_eq!(updated.revision, 2);
    assert_eq!(updated.resource_bindings, Vec::new());
    runtime.close().await;

    let reopened = initialized(&codex_home).await;
    assert_eq!(
        reopened
            .get_thread_execution_context_record(&context.thread_id)
            .await
            .expect("read reopened Thread execution context"),
        Some(updated)
    );
    assert_eq!(
        reopened
            .unbind_provider_resource_binding_record(&ProviderResourceBindingUnbindRequest {
                binding_id: binding.binding_id.clone(),
                local_actor_id: binding.local_actor_id.clone(),
                local_tenant_id: binding.local_tenant_id.clone(),
                local_space_id: binding.local_space_id.clone(),
                expected_revision: 1,
                unbound_at: 120,
            })
            .await
            .expect("unbind Provider resource"),
        ProviderResourceBindingUnbindOutcome::Unbound
    );
    let mut restore_binding = update;
    restore_binding.expected_revision = 2;
    restore_binding.resource_bindings = context.resource_bindings;
    restore_binding.updated_at = 130;
    assert_eq!(
        reopened
            .update_thread_execution_context_bindings(&restore_binding)
            .await
            .expect("reject revoked binding"),
        ThreadExecutionContextUpdateOutcome::DependencyMissing
    );
    let thread_id = ThreadId::from_string(&context.thread_id).expect("valid Thread id");
    reopened
        .delete_threads_strict(&[thread_id])
        .await
        .expect("delete Thread execution context with Thread state");
    assert_eq!(
        reopened
            .get_thread_execution_context_record(&context.thread_id)
            .await
            .expect("read deleted Thread execution context"),
        None
    );

    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn execution_binding_requires_exact_active_provider_agent_and_survives_restart() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    seed_parents(&runtime).await;
    let agent = conversation_binding();
    let mut skill = binding_record("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c402");
    skill.workspace_scope = ProviderResourceWorkspaceScope::Conversation;
    skill.workspace_scope_id = "019f550e-ba52-7490-a248-b0d3a84103c1".to_string();
    skill.resource_kind = ProviderResourceKind::Skill;
    skill.resource_id = "skill-demo".to_string();
    skill.resource_revision = "skill-version:7".to_string();
    skill.record_hash = skill.canonical_hash();
    for binding in [&agent, &skill] {
        assert!(matches!(
            runtime
                .resolve_provider_resource_binding_record(binding)
                .await
                .expect("create Provider resource binding"),
            ProviderResourceBindingResolveOutcome::Created(_)
        ));
    }

    let agent_ref = crate::ThreadExecutionContextBindingRef {
        binding_id: agent.binding_id.clone(),
        revision: agent.revision,
    };
    let skill_ref = crate::ThreadExecutionContextBindingRef {
        binding_id: skill.binding_id.clone(),
        revision: skill.revision,
    };
    let mut context = context_record();
    context.resource_bindings = vec![agent_ref.clone(), skill_ref.clone()];
    context.resource_bindings.sort();
    context.execution_binding = Some(agent_ref.clone());
    context.record_hash = context.canonical_hash();
    assert_eq!(
        runtime
            .create_thread_execution_context_record(&context)
            .await
            .expect("create execution-bound context"),
        ThreadExecutionContextCreateOutcome::Created
    );

    let non_agent = ThreadExecutionContextBindingUpdate {
        thread_id: context.thread_id.clone(),
        local_actor_id: context.local_actor_id.clone(),
        local_tenant_id: context.local_tenant_id.clone(),
        local_space_id: context.local_space_id.clone(),
        expected_revision: 1,
        resource_bindings: context.resource_bindings.clone(),
        execution_binding: Some(skill_ref),
        updated_at: 110,
    };
    assert_eq!(
        runtime
            .update_thread_execution_context_bindings(&non_agent)
            .await
            .expect("reject non-Agent execution binding"),
        ThreadExecutionContextUpdateOutcome::DependencyMissing
    );

    let drifted_ref = crate::ThreadExecutionContextBindingRef {
        binding_id: agent_ref.binding_id,
        revision: 2,
    };
    let mut drifted_bindings = context.resource_bindings.clone();
    drifted_bindings[0] = drifted_ref.clone();
    drifted_bindings.sort();
    let revision_drift = ThreadExecutionContextBindingUpdate {
        resource_bindings: drifted_bindings,
        execution_binding: Some(drifted_ref),
        ..non_agent
    };
    assert_eq!(
        runtime
            .update_thread_execution_context_bindings(&revision_drift)
            .await
            .expect("reject execution binding revision drift"),
        ThreadExecutionContextUpdateOutcome::DependencyMissing
    );
    let stored = runtime
        .get_thread_execution_context_record(&context.thread_id)
        .await
        .expect("read execution-bound context")
        .expect("execution-bound context exists");
    assert_eq!(stored, context);
    runtime.close().await;

    let reopened = initialized(&codex_home).await;
    assert_eq!(
        reopened
            .get_thread_execution_context_record(&context.thread_id)
            .await
            .expect("read restarted execution-bound context"),
        Some(context)
    );
    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

async fn seed_parents(runtime: &StateRuntime) {
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
    let connection = connection_record("provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101");
    assert_eq!(
        runtime
            .resolve_provider_connection_record(&connection)
            .await
            .expect("create Provider connection"),
        ProviderConnectionResolveOutcome::Created(connection)
    );
}

fn conversation_binding() -> crate::ProviderResourceBindingRecord {
    let mut binding = binding_record("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c401");
    binding.workspace_scope = ProviderResourceWorkspaceScope::Conversation;
    binding.workspace_scope_id = "019f550e-ba52-7490-a248-b0d3a84103c1".to_string();
    binding.record_hash = binding.canonical_hash();
    binding
}

async fn initialized(codex_home: &std::path::Path) -> std::sync::Arc<StateRuntime> {
    StateRuntime::init(codex_home.to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize State")
}
