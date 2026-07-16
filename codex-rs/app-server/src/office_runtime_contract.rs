pub(crate) const OFFICE_SCOPED_RUNTIME_VERSION: u64 = 2;
pub(crate) const OFFICE_MEMBER_RUNTIME_REPAIR_THREAD_SOURCE: &str =
    "office_member_runtime_repair_v2";
pub(crate) const OFFICE_AUTOMATION_RUNTIME_THREAD_SOURCE: &str = "office_automation_runtime";
pub(crate) const OFFICE_MANAGER_RUNTIME_THREAD_SOURCE: &str = "office_manager_runtime_v1";
pub(crate) const EXTERNAL_OFFICE_RUNTIME_MUTATION_ERROR: &str =
    "direct app-server mutation is not allowed for an Office-scoped runtime";
pub(crate) const MAX_OFFICE_REPAIRED_RUNTIME_BINDINGS: usize = 16;
pub(crate) const MAX_OFFICE_RUNTIME_ID_CHARS: usize = 128;

pub(crate) fn is_protected_office_runtime_source(source: &str) -> bool {
    matches!(
        source,
        OFFICE_MEMBER_RUNTIME_REPAIR_THREAD_SOURCE
            | OFFICE_AUTOMATION_RUNTIME_THREAD_SOURCE
            | OFFICE_MANAGER_RUNTIME_THREAD_SOURCE
    )
}
