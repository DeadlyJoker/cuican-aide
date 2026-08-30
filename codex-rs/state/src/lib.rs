//! SQLite-backed state for rollout metadata.
//!
//! This crate is intentionally small and focused: it extracts rollout metadata
//! from JSONL rollouts and mirrors it into a local SQLite database. Backfill
//! orchestration and rollout scanning live in `crewon-core`.

mod artifact_record_schema;
mod artifact_record_validation;
mod artifact_records;
mod artifact_storage;
mod audit;
mod cloud_agent_legacy_import_records;
mod cloud_agent_thread_summary_records;
mod cloud_agent_turn_page_records;
mod cloud_agent_turn_projection_records;
mod cloud_agent_turn_records;
#[cfg(test)]
#[path = "cloud_agent_turn_records_tests.rs"]
mod cloud_agent_turn_records_tests;
mod durable_workspace_records;
mod dynamic_tool_execution_records;
mod dynamic_tool_execution_validation;
mod extract;
pub mod log_db;
mod migrations;
mod model;
mod office_migration_records;
mod paths;
mod provider_access_grant_records;
mod provider_connection_records;
mod provider_execution_records;
mod provider_execution_recovery_records;
mod provider_execution_validation;
mod provider_identity_records;
mod provider_identity_refresh_records;
mod provider_identity_validation;
mod provider_resource_binding_lifecycle;
mod provider_resource_binding_records;
mod provider_run_event_projection_records;
mod runtime;
mod task_runtime_control_records;
mod task_runtime_records;
mod task_runtime_storage;
mod telemetry;
mod thread_execution_context_records;
#[cfg(test)]
#[path = "thread_execution_context_records_tests.rs"]
mod thread_execution_context_records_tests;

pub use model::LogEntry;
pub use model::LogQuery;
pub use model::LogRow;
pub use model::Phase2JobClaimOutcome;
/// Preferred entrypoint: owns configuration and metrics.
pub use runtime::StateRuntime;
pub use task_runtime_control_records::*;
pub use task_runtime_records::*;
pub use task_runtime_storage::*;
pub use thread_execution_context_records::*;

pub(crate) use artifact_record_validation::digest_bytes;
pub(crate) use artifact_record_validation::digest_parts;
pub use artifact_records::*;
pub use artifact_storage::*;
pub use audit::ThreadStateAuditRow;
pub use audit::read_thread_state_audit_rows;
pub use cloud_agent_legacy_import_records::*;
pub use cloud_agent_thread_summary_records::*;
pub use cloud_agent_turn_page_records::*;
pub use cloud_agent_turn_projection_records::*;
pub use cloud_agent_turn_records::*;
pub use durable_workspace_records::*;
pub use dynamic_tool_execution_records::*;
/// Low-level storage engine: useful for focused tests.
///
/// Most consumers should prefer [`StateRuntime`].
pub use extract::apply_rollout_item;
pub use extract::rollout_item_affects_thread_metadata;
pub use model::AgentJob;
pub use model::AgentJobCreateParams;
pub use model::AgentJobItem;
pub use model::AgentJobItemCreateParams;
pub use model::AgentJobItemStatus;
pub use model::AgentJobProgress;
pub use model::AgentJobStatus;
pub use model::Anchor;
pub use model::BackfillState;
pub use model::BackfillStats;
pub use model::BackfillStatus;
pub use model::DirectionalThreadSpawnEdgeStatus;
pub use model::ExtractionOutcome;
pub use model::SortDirection;
pub use model::SortKey;
pub use model::Stage1JobClaim;
pub use model::Stage1JobClaimOutcome;
pub use model::Stage1Output;
pub use model::Stage1StartupClaimParams;
pub use model::ThreadGoal;
pub use model::ThreadGoalStatus;
pub use model::ThreadMetadata;
pub use model::ThreadMetadataBuilder;
pub use model::ThreadsPage;
pub use office_migration_records::*;
pub use provider_access_grant_records::*;
pub use provider_connection_records::*;
pub use provider_execution_records::*;
pub use provider_execution_recovery_records::*;
pub use provider_identity_records::*;
pub use provider_identity_refresh_records::*;
pub use provider_resource_binding_lifecycle::*;
pub use provider_resource_binding_records::*;
pub use provider_run_event_projection_records::*;
pub use runtime::GoalAccountingMode;
pub use runtime::GoalAccountingOutcome;
pub use runtime::GoalStore;
pub use runtime::GoalUpdate;
pub use runtime::MemoryStore;
pub use runtime::RemoteControlEnrollmentRecord;
pub use runtime::RuntimeDbBackup;
pub use runtime::RuntimeDbPath;
pub use runtime::ThreadFilterOptions;
pub use runtime::backup_runtime_db_for_fresh_start;
pub use runtime::goals_db_filename;
pub use runtime::goals_db_path;
pub use runtime::is_sqlite_corruption_error;
pub use runtime::logs_db_filename;
pub use runtime::logs_db_path;
pub use runtime::memories_db_filename;
pub use runtime::memories_db_path;
pub use runtime::runtime_db_path_for_corruption_error;
pub use runtime::runtime_db_paths;
pub use runtime::sqlite_error_detail_is_corruption;
pub use runtime::sqlite_error_detail_is_lock;
pub use runtime::sqlite_integrity_check;
pub use runtime::state_db_filename;
pub use runtime::state_db_path;
pub use telemetry::DbTelemetry;
pub use telemetry::DbTelemetryHandle;
pub use telemetry::install_process_db_telemetry;
pub use telemetry::record_backfill_gate;
pub use telemetry::record_fallback;

/// Environment variable for overriding the SQLite state database home directory.
pub const SQLITE_HOME_ENV: &str = "CODEX_SQLITE_HOME";

pub const LOGS_DB_FILENAME: &str = "logs_2.sqlite";
pub const GOALS_DB_FILENAME: &str = "goals_1.sqlite";
pub const MEMORIES_DB_FILENAME: &str = "memories_1.sqlite";
pub const STATE_DB_FILENAME: &str = "state_5.sqlite";

/// Errors encountered during DB operations. Tags: [stage]
pub const DB_ERROR_METRIC: &str = "codex.db.error";
/// Metrics on backfill process. Tags: [status]
pub const DB_METRIC_BACKFILL: &str = "codex.db.backfill";
/// Metrics on backfill duration. Tags: [status]
pub const DB_METRIC_BACKFILL_DURATION_MS: &str = "codex.db.backfill.duration_ms";
/// SQLite initialization attempts. Tags: [status, phase, db, error]
pub const DB_INIT_METRIC: &str = "codex.sqlite.init.count";
/// SQLite initialization latency. Tags: [status, phase, db, error]
pub const DB_INIT_DURATION_METRIC: &str = "codex.sqlite.init.duration_ms";
/// Rollout fallback attempts. Tags: [caller, reason]
pub const DB_FALLBACK_METRIC: &str = "codex.sqlite.fallback.count";

#[cfg(test)]
#[path = "artifact_records_tests.rs"]
mod artifact_records_tests;

#[cfg(test)]
#[path = "task_runtime_records_tests.rs"]
mod task_runtime_records_tests;

#[cfg(test)]
#[path = "provider_execution_records_tests.rs"]
mod provider_execution_records_tests;

#[cfg(test)]
#[path = "provider_identity_records_tests.rs"]
mod provider_identity_records_tests;

#[cfg(test)]
#[path = "provider_connection_records_tests.rs"]
mod provider_connection_records_tests;

#[cfg(test)]
#[path = "provider_access_grant_records_tests.rs"]
mod provider_access_grant_records_tests;

#[cfg(test)]
#[path = "provider_resource_binding_records_tests.rs"]
mod provider_resource_binding_records_tests;

#[cfg(test)]
#[path = "durable_workspace_records_tests.rs"]
mod durable_workspace_records_tests;

#[cfg(test)]
#[path = "dynamic_tool_execution_records_tests.rs"]
mod dynamic_tool_execution_records_tests;
