use pretty_assertions::assert_eq;

use super::WorkspaceAuthorityLease;
use crate::workspace_native::WorkspaceNativeError;

#[test]
fn only_one_process_authority_lease_can_own_the_catalog_directory() {
    let root = tempfile::tempdir().unwrap();
    let first = WorkspaceAuthorityLease::acquire(root.path()).unwrap();
    assert_eq!(
        WorkspaceAuthorityLease::acquire(root.path()).unwrap_err(),
        WorkspaceNativeError::AuthorityUnavailable
    );
    drop(first);
    WorkspaceAuthorityLease::acquire(root.path()).unwrap();
}
