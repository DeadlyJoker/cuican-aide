//! Rollout persistence and discovery for Crewon session files.

use std::sync::LazyLock;

use crewon_protocol::protocol::SessionSource;

pub(crate) mod compression;
pub(crate) mod config;
mod generation_lock;
mod legacy_fence;
pub(crate) mod list;
pub(crate) mod metadata;
pub(crate) mod policy;
pub(crate) mod recorder;
pub(crate) mod search;
pub(crate) mod session_index;
mod sqlite_metrics;
pub mod state_db;
mod writer_lock;
pub use writer_lock::RolloutWriterLease;

pub(crate) mod default_client {
    pub use crewon_login::default_client::*;
}

pub(crate) use crewon_protocol::protocol;

pub const SESSIONS_SUBDIR: &str = "sessions";
pub const ARCHIVED_SESSIONS_SUBDIR: &str = "archived_sessions";
pub(crate) const WRITER_LOCKS_DIR: &str = ".rollout-writer-locks";
pub static INTERACTIVE_SESSION_SOURCES: LazyLock<Vec<SessionSource>> = LazyLock::new(|| {
    vec![
        SessionSource::LegacyCli,
        SessionSource::VSCode,
        SessionSource::Custom("atlas".to_string()),
        SessionSource::Custom("chatgpt".to_string()),
    ]
});

pub use compression::RolloutLineReader;
pub use compression::existing_rollout_path;
pub use compression::open_rollout_line_reader;
pub use compression::plain_rollout_path;
pub use compression::spawn_rollout_compression_worker;
pub use config::Config;
pub use config::RolloutConfig;
pub use config::RolloutConfigView;
pub use crewon_protocol::protocol::SessionMeta;
pub use generation_lock::RolloutWriterGenerationGuard;
pub use generation_lock::RolloutWriterGenerationMode;
pub use generation_lock::acquire_rollout_writer_generation;
pub use legacy_fence::LegacyFenceViolation;
pub use legacy_fence::RolloutFenceState;
pub use legacy_fence::RolloutMutation;
pub use legacy_fence::is_legacy_fence_violation;
pub use legacy_fence::legacy_fence_violation;
pub use list::Cursor;
pub use list::SortDirection;
pub use list::ThreadItem;
pub use list::ThreadListConfig;
pub use list::ThreadListLayout;
pub use list::ThreadSortKey;
pub use list::ThreadsPage;
pub use list::find_archived_thread_path_by_id_str;
pub use list::find_thread_path_by_id_str;
#[deprecated(note = "use find_thread_path_by_id_str")]
pub use list::find_thread_path_by_id_str as find_conversation_path_by_id_str;
pub use list::get_threads;
pub use list::get_threads_in_root;
pub use list::parse_cursor;
pub use list::read_head_for_summary;
pub use list::read_session_meta_line;
pub use list::read_thread_item_from_rollout;
pub use list::rollout_date_parts;
pub use metadata::builder_from_items;
pub use policy::is_persisted_rollout_item;
pub use policy::persisted_rollout_items;
pub use policy::should_persist_response_item_for_memories;
pub use recorder::RolloutRecorder;
pub use recorder::RolloutRecorderParams;
pub use recorder::append_rollout_item_to_path;
pub use recorder::append_rollout_item_to_path_with_lease;
pub use search::first_rollout_content_match_snippet;
pub use search::search_rollout_matches;
pub use search::search_rollout_paths;
pub use session_index::append_thread_name;
pub use session_index::find_thread_meta_by_name_str;
pub use session_index::find_thread_name_by_id;
pub use session_index::find_thread_names_by_ids;
pub use session_index::remove_thread_name_entries;
pub use state_db::StateDbHandle;
pub use state_db::sqlite_telemetry_recorder;

#[cfg(test)]
mod tests;
