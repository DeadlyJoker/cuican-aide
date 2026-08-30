use crewon_app_server_protocol::JSONRPCErrorError;
use tokio::fs;

use super::DomainKind;
use super::domain_directory;
use super::map_io_error;
use super::office_record_lock;

const OFFICE_AUTHORITY_FILE_NAME: &str = ".authority";

pub(super) struct OfficeAuthorityGuard {
    _guard: office_record_lock::OfficeRecordMutationGuard,
}

pub(super) async fn lock(cwd: &str) -> Result<OfficeAuthorityGuard, JSONRPCErrorError> {
    let directory = domain_directory(cwd, DomainKind::Office)?;
    fs::create_dir_all(&directory).await.map_err(map_io_error)?;
    let guard = office_record_lock::lock(&directory.join(OFFICE_AUTHORITY_FILE_NAME))
        .await
        .map_err(map_io_error)?;
    Ok(OfficeAuthorityGuard { _guard: guard })
}
