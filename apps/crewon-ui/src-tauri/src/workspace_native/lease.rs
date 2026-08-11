use std::fs::File;
use std::fs::OpenOptions;
use std::path::Path;

use super::catalog_io::prepare_authority_directory;
use super::WorkspaceNativeError;

const LEASE_FILE_NAME: &str = "workspace-authority.lock";

pub(crate) struct WorkspaceAuthorityLease {
    file: File,
}

impl std::fmt::Debug for WorkspaceAuthorityLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("WorkspaceAuthorityLease([REDACTED])")
    }
}

impl WorkspaceAuthorityLease {
    pub(crate) fn acquire(directory: &Path) -> Result<Self, WorkspaceNativeError> {
        prepare_authority_directory(directory)?;
        let path = directory.join(LEASE_FILE_NAME);
        if std::fs::symlink_metadata(&path)
            .is_ok_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_file())
        {
            return Err(WorkspaceNativeError::AuthorityInvalid);
        }
        let mut options = OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt as _;
            use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
            options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        }
        let file = options
            .open(&path)
            .map_err(|_| WorkspaceNativeError::AuthorityUnavailable)?;
        validate_lease_file(&file)?;
        lock_file(&file)?;
        Ok(Self { file })
    }
}

#[cfg(unix)]
fn validate_lease_file(file: &File) -> Result<(), WorkspaceNativeError> {
    use std::os::unix::fs::PermissionsExt as _;
    let metadata = file
        .metadata()
        .map_err(|_| WorkspaceNativeError::AuthorityInvalid)?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o777 != 0o600 {
        return Err(WorkspaceNativeError::AuthorityInvalid);
    }
    Ok(())
}

#[cfg(windows)]
fn validate_lease_file(file: &File) -> Result<(), WorkspaceNativeError> {
    use std::os::windows::fs::MetadataExt as _;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    let metadata = file
        .metadata()
        .map_err(|_| WorkspaceNativeError::AuthorityInvalid)?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(WorkspaceNativeError::AuthorityInvalid);
    }
    Ok(())
}

#[cfg(unix)]
fn lock_file(file: &File) -> Result<(), WorkspaceNativeError> {
    use std::os::fd::AsRawFd as _;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(WorkspaceNativeError::AuthorityUnavailable);
    }
    Ok(())
}

#[cfg(windows)]
fn lock_file(file: &File) -> Result<(), WorkspaceNativeError> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Storage::FileSystem::LockFile;
    let locked = unsafe { LockFile(file.as_raw_handle(), 0, 0, u32::MAX, u32::MAX) };
    if locked == 0 {
        return Err(WorkspaceNativeError::AuthorityUnavailable);
    }
    Ok(())
}

impl Drop for WorkspaceAuthorityLease {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd as _;
            let _ = unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle as _;
            use windows_sys::Win32::Storage::FileSystem::UnlockFile;
            let _ = unsafe { UnlockFile(self.file.as_raw_handle(), 0, 0, u32::MAX, u32::MAX) };
        }
    }
}

#[cfg(test)]
#[path = "lease_tests.rs"]
mod tests;
