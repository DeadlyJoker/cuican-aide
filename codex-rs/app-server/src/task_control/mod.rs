mod cloud_agent_legacy_import_artifact;
mod cloud_agent_legacy_import_source;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "W3-01 legacy importer is composed only during the bounded cutover window"
    )
)]
mod cloud_agent_legacy_importer;
mod cloud_agent_result_reader;
pub(crate) mod cloud_agent_task_authority;
pub(crate) mod cloud_agent_thread_metadata_projection;
pub(crate) mod cloud_agent_thread_projection;
mod cloud_agent_turn_artifacts;
pub(crate) mod cloud_agent_turn_cancellation;
pub(crate) mod cloud_agent_turn_coordinator;
pub(crate) mod cloud_agent_turn_projector;
mod cloud_agent_turn_projector_output;
#[cfg(test)]
#[path = "cloud_agent_turn_projector_test_support.rs"]
mod cloud_agent_turn_projector_test_support;
mod cloud_agent_turn_replay;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "W2-07 execution resolver is harnessed before CloudWorker composition"
    )
)]
mod cloud_execution_resolver;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "W2-07 CloudWorker is harnessed before production composition"
    )
)]
mod cloud_worker;
mod cloud_worker_event_projection;
mod cloud_worker_journal;
mod cloud_worker_start;
pub(crate) mod provider_control_production;
#[cfg(test)]
#[path = "provider_control_production_tests.rs"]
mod provider_control_production_tests;
mod provider_control_supervisor;
#[cfg(test)]
#[path = "provider_control_supervisor_tests.rs"]
mod provider_control_supervisor_tests;
mod provider_run_artifact_importer;
mod provider_run_authority;
pub(crate) mod task_state_store_adapter;
