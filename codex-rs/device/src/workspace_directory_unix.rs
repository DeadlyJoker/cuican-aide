use std::ffi::CStr;
use std::io;
use std::os::fd::RawFd;
use std::os::unix::ffi::OsStrExt as _;
use std::path::Path;
use std::ptr;

use libc::DIR;

use super::ScanBudget;
use super::WorkspaceDirectoryEntry;
use super::WorkspaceDirectoryEntryKind;
use super::WorkspaceDirectoryError;
use super::WorkspaceListCancellation;
use super::entry_from_utf8_bytes;
use super::validate_scan_progress;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DirectoryIdentity {
    device: libc::dev_t,
    inode: libc::ino_t,
}

pub(super) struct StableDirectory {
    stream: *mut DIR,
    identity: DirectoryIdentity,
}

// The stream is exclusively removed from the registry before use. No two
// threads may enumerate it concurrently, and Drop owns the only close.
unsafe impl Send for StableDirectory {}

impl std::fmt::Debug for StableDirectory {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StableDirectory")
            .field("identity", &self.identity)
            .finish_non_exhaustive()
    }
}

impl StableDirectory {
    pub(super) fn open(path: &Path) -> Result<Self, WorkspaceDirectoryError> {
        let path_bytes = path.as_os_str().as_bytes();
        if path_bytes.is_empty() || path_bytes.contains(&0) {
            return Err(WorkspaceDirectoryError::new(
                "workspace_directory_path_invalid",
            ));
        }
        let mut nul_terminated = Vec::with_capacity(path_bytes.len() + 1);
        nul_terminated.extend_from_slice(path_bytes);
        nul_terminated.push(0);
        // SAFETY: the path buffer is NUL-terminated and lives through the call.
        let fd = unsafe {
            libc::open(
                nul_terminated.as_ptr().cast(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io_error("workspace_directory_open_failed"));
        }
        let identity = match identity_for_fd(fd) {
            Ok(identity) => identity,
            Err(error) => {
                // SAFETY: fd was returned by open and has not been transferred.
                unsafe { libc::close(fd) };
                return Err(error);
            }
        };
        // SAFETY: fd is an open directory descriptor and ownership transfers
        // to the resulting DIR stream on success.
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            // SAFETY: fdopendir did not take ownership on failure.
            unsafe { libc::close(fd) };
            return Err(io_error("workspace_directory_open_failed"));
        }
        Ok(Self { stream, identity })
    }

    pub(super) fn scan(
        &mut self,
        budget: ScanBudget,
        cancellation: &WorkspaceListCancellation,
    ) -> Result<Vec<WorkspaceDirectoryEntry>, WorkspaceDirectoryError> {
        self.require_same_identity()?;
        // SAFETY: self exclusively owns a valid DIR stream.
        unsafe { libc::rewinddir(self.stream) };
        let mut entries = Vec::new();
        let mut scanned_entries = 0usize;
        let mut scanned_name_bytes = 0usize;
        loop {
            validate_scan_progress(cancellation, budget.deadline)?;
            if scanned_entries >= budget.max_scanned_entries {
                return Err(WorkspaceDirectoryError::new(
                    "workspace_list_scan_limit_exceeded",
                ));
            }
            if budget.max_scanned_name_bytes - scanned_name_bytes < budget.max_name_bytes {
                return Err(WorkspaceDirectoryError::new(
                    "workspace_list_scan_bytes_exceeded",
                ));
            }
            set_errno(0);
            // SAFETY: self exclusively owns the stream and readdir's pointer is
            // consumed before the next call.
            let raw_entry = unsafe { libc::readdir(self.stream) };
            if raw_entry.is_null() {
                if errno() == 0 {
                    break;
                }
                return Err(io_error("workspace_directory_read_failed"));
            }
            // SAFETY: d_name is NUL-terminated by readdir for this entry.
            let name = unsafe { CStr::from_ptr((*raw_entry).d_name.as_ptr()) };
            let name_bytes = name.to_bytes();
            if name_bytes == b"." || name_bytes == b".." {
                continue;
            }
            scanned_entries += 1;
            scanned_name_bytes = scanned_name_bytes
                .checked_add(name_bytes.len())
                .ok_or_else(|| {
                    WorkspaceDirectoryError::new("workspace_list_scan_bytes_exceeded")
                })?;
            if scanned_name_bytes > budget.max_scanned_name_bytes {
                return Err(WorkspaceDirectoryError::new(
                    "workspace_list_scan_bytes_exceeded",
                ));
            }
            let kind = self.entry_kind(name.as_ptr())?;
            entries.push(entry_from_utf8_bytes(
                name_bytes,
                kind,
                budget.max_name_bytes,
            )?);
        }
        validate_scan_progress(cancellation, budget.deadline)?;
        self.require_same_identity()?;
        Ok(entries)
    }

    fn entry_kind(
        &self,
        name: *const libc::c_char,
    ) -> Result<WorkspaceDirectoryEntryKind, WorkspaceDirectoryError> {
        let mut status = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: stream is valid, name is the current readdir entry, and the
        // output points to initialized storage on success.
        let result = unsafe {
            libc::fstatat(
                libc::dirfd(self.stream),
                name,
                status.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result != 0 {
            return Err(io_error("workspace_directory_entry_stat_failed"));
        }
        // SAFETY: fstatat succeeded and initialized status.
        let mode = unsafe { status.assume_init() }.st_mode & libc::S_IFMT;
        match mode {
            libc::S_IFREG => Ok(WorkspaceDirectoryEntryKind::File),
            libc::S_IFDIR => Ok(WorkspaceDirectoryEntryKind::Directory),
            libc::S_IFLNK => Err(WorkspaceDirectoryError::new(
                "workspace_list_link_entry_unsupported",
            )),
            _ => Err(WorkspaceDirectoryError::new(
                "workspace_list_entry_type_unsupported",
            )),
        }
    }

    fn require_same_identity(&self) -> Result<(), WorkspaceDirectoryError> {
        let fd = unsafe { libc::dirfd(self.stream) };
        if identity_for_fd(fd)? != self.identity {
            return Err(WorkspaceDirectoryError::new(
                "workspace_directory_identity_changed",
            ));
        }
        Ok(())
    }
}

impl Drop for StableDirectory {
    fn drop(&mut self) {
        if !self.stream.is_null() {
            // SAFETY: this type uniquely owns the DIR stream.
            unsafe { libc::closedir(self.stream) };
            self.stream = ptr::null_mut();
        }
    }
}

fn identity_for_fd(fd: RawFd) -> Result<DirectoryIdentity, WorkspaceDirectoryError> {
    let mut status = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: status points to valid storage and fd is owned by the caller.
    if unsafe { libc::fstat(fd, status.as_mut_ptr()) } != 0 {
        return Err(io_error("workspace_directory_identity_failed"));
    }
    // SAFETY: fstat succeeded and initialized status.
    let status = unsafe { status.assume_init() };
    if status.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return Err(WorkspaceDirectoryError::new(
            "workspace_directory_not_directory",
        ));
    }
    Ok(DirectoryIdentity {
        device: status.st_dev,
        inode: status.st_ino,
    })
}

fn io_error(code: &'static str) -> WorkspaceDirectoryError {
    WorkspaceDirectoryError::with_source(code, io::Error::last_os_error())
}

#[cfg(target_os = "linux")]
fn errno() -> libc::c_int {
    // SAFETY: libc exposes thread-local errno through this pointer.
    unsafe { *libc::__errno_location() }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn errno() -> libc::c_int {
    // SAFETY: libc exposes thread-local errno through this pointer.
    unsafe { *libc::__error() }
}

#[cfg(target_os = "linux")]
fn set_errno(value: libc::c_int) {
    // SAFETY: libc exposes thread-local errno through this pointer.
    unsafe { *libc::__errno_location() = value };
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn set_errno(value: libc::c_int) {
    // SAFETY: libc exposes thread-local errno through this pointer.
    unsafe { *libc::__error() = value };
}
