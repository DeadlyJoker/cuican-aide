use std::io;
use std::os::windows::ffi::OsStrExt as _;
use std::path::Path;
use std::ptr;

use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::Foundation::STATUS_NO_MORE_FILES;
use windows_sys::Win32::Foundation::STATUS_SUCCESS;
use windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION;
use windows_sys::Win32::Storage::FileSystem::CreateFileW;
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_DEVICE;
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_DIRECTORY;
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
use windows_sys::Win32::Storage::FileSystem::FILE_LIST_DIRECTORY;
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_DELETE;
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_WRITE;
use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandle;
use windows_sys::Win32::Storage::FileSystem::OPEN_EXISTING;
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;
use windows_sys::Wdk::Storage::FileSystem::FILE_ID_BOTH_DIR_INFORMATION;
use windows_sys::Wdk::Storage::FileSystem::FileIdBothDirectoryInformation;
use windows_sys::Wdk::Storage::FileSystem::NtQueryDirectoryFile;

use super::ScanBudget;
use super::WorkspaceDirectoryEntry;
use super::WorkspaceDirectoryEntryKind;
use super::WorkspaceDirectoryError;
use super::WorkspaceListCancellation;
use super::entry_from_utf8_bytes;
use super::validate_scan_progress;

const DIRECTORY_INFORMATION_BUFFER_BYTES: usize =
    std::mem::size_of::<FILE_ID_BOTH_DIR_INFORMATION>() + 2 * 255;

#[repr(C, align(8))]
struct DirectoryInformationBuffer([u8; DIRECTORY_INFORMATION_BUFFER_BYTES]);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DirectoryIdentity {
    volume_serial: u32,
    file_index: u64,
}

pub(super) struct StableDirectory {
    handle: HANDLE,
    identity: DirectoryIdentity,
}

// HANDLE ownership is exclusive and every operation is serialized by the
// registry lease before this value can move to another thread.
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
        let mut path_wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        if path_wide.is_empty() || path_wide.contains(&0) {
            return Err(WorkspaceDirectoryError::new(
                "workspace_directory_path_invalid",
            ));
        }
        path_wide.push(0);
        // SAFETY: path_wide is NUL-terminated and every pointer argument is
        // valid for the duration of CreateFileW.
        let handle = unsafe {
            CreateFileW(
                path_wide.as_ptr(),
                FILE_LIST_DIRECTORY,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io_error("workspace_directory_open_failed"));
        }
        let identity = match identity_for_handle(handle) {
            Ok(identity) => identity,
            Err(error) => {
                // SAFETY: handle is valid and uniquely owned here.
                unsafe { CloseHandle(handle) };
                return Err(error);
            }
        };
        Ok(Self { handle, identity })
    }

    pub(super) fn scan(
        &mut self,
        budget: ScanBudget,
        cancellation: &WorkspaceListCancellation,
    ) -> Result<Vec<WorkspaceDirectoryEntry>, WorkspaceDirectoryError> {
        self.require_same_identity()?;
        let mut entries = Vec::new();
        let mut scanned_entries = 0usize;
        let mut scanned_name_bytes = 0usize;
        let mut restart = true;
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
            let mut buffer = DirectoryInformationBuffer([0u8; DIRECTORY_INFORMATION_BUFFER_BYTES]);
            let mut io_status = IO_STATUS_BLOCK::default();
            // SAFETY: the handle is an open directory, buffer is writable, and
            // ReturnSingleEntry prevents reading beyond the remaining budget.
            let status = unsafe {
                NtQueryDirectoryFile(
                    self.handle,
                    ptr::null_mut(),
                    None,
                    ptr::null(),
                    &mut io_status,
                    buffer.0.as_mut_ptr().cast(),
                    buffer.0.len() as u32,
                    FileIdBothDirectoryInformation,
                    true,
                    ptr::null(),
                    restart,
                )
            };
            restart = false;
            if status == STATUS_NO_MORE_FILES {
                break;
            }
            if status != STATUS_SUCCESS {
                return Err(WorkspaceDirectoryError::new(
                    "workspace_directory_read_failed",
                ));
            }
            // SAFETY: NtQueryDirectoryFile succeeded with the exact structure
            // class and one complete entry in buffer.
            let raw = unsafe {
                &*(buffer
                    .0
                    .as_ptr()
                    .cast::<FILE_ID_BOTH_DIR_INFORMATION>())
            };
            let name_units = usize::try_from(raw.FileNameLength)
                .ok()
                .and_then(|length| length.checked_div(2))
                .ok_or_else(|| {
                    WorkspaceDirectoryError::new("workspace_list_entry_name_invalid")
                })?;
            let name_offset = std::mem::offset_of!(FILE_ID_BOTH_DIR_INFORMATION, FileName);
            let required_bytes = name_offset
                .checked_add(raw.FileNameLength as usize)
                .ok_or_else(|| {
                    WorkspaceDirectoryError::new("workspace_list_entry_name_invalid")
                })?;
            if raw.FileNameLength % 2 != 0
                || name_units > 255
                || required_bytes > buffer.0.len()
                || required_bytes > io_status.Information
            {
                return Err(WorkspaceDirectoryError::new(
                    "workspace_list_entry_name_invalid",
                ));
            }
            // SAFETY: FileNameLength is supplied by the successful kernel call
            // and the buffer was sized for the maximum accepted name.
            let wide_name = unsafe {
                std::slice::from_raw_parts(raw.FileName.as_ptr(), name_units)
            };
            let name = String::from_utf16(wide_name).map_err(|error| {
                WorkspaceDirectoryError::with_source(
                    "workspace_list_entry_name_invalid",
                    error,
                )
            })?;
            let name_bytes = name.as_bytes();
            if matches!(name.as_str(), "." | "..") {
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
            if raw.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(WorkspaceDirectoryError::new(
                    "workspace_list_link_entry_unsupported",
                ));
            }
            let kind = if raw.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
                WorkspaceDirectoryEntryKind::Directory
            } else if raw.FileAttributes & FILE_ATTRIBUTE_DEVICE == 0 {
                WorkspaceDirectoryEntryKind::File
            } else {
                return Err(WorkspaceDirectoryError::new(
                    "workspace_list_entry_type_unsupported",
                ));
            };
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

    fn require_same_identity(&self) -> Result<(), WorkspaceDirectoryError> {
        if identity_for_handle(self.handle)? != self.identity {
            return Err(WorkspaceDirectoryError::new(
                "workspace_directory_identity_changed",
            ));
        }
        Ok(())
    }
}

impl Drop for StableDirectory {
    fn drop(&mut self) {
        if self.handle != INVALID_HANDLE_VALUE {
            // SAFETY: this type uniquely owns the handle.
            unsafe { CloseHandle(self.handle) };
            self.handle = INVALID_HANDLE_VALUE;
        }
    }
}

fn identity_for_handle(handle: HANDLE) -> Result<DirectoryIdentity, WorkspaceDirectoryError> {
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: handle is valid and information points to writable storage.
    if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
        return Err(io_error("workspace_directory_identity_failed"));
    }
    if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(WorkspaceDirectoryError::new(
            "workspace_directory_root_reparse_unsupported",
        ));
    }
    if information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err(WorkspaceDirectoryError::new(
            "workspace_directory_not_directory",
        ));
    }
    Ok(DirectoryIdentity {
        volume_serial: information.dwVolumeSerialNumber,
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
    })
}

fn io_error(code: &'static str) -> WorkspaceDirectoryError {
    WorkspaceDirectoryError::with_source(code, io::Error::last_os_error())
}
