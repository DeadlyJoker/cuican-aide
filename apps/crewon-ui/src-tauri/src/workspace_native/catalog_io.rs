use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::Read as _;
use std::io::Write as _;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use serde::de::DeserializeOwned;
use serde::Serialize;

use super::WorkspaceNativeError;

const MAX_CATALOG_BYTES: u64 = 32 * 1024;
static CATALOG_MUTATION_UNKNOWN: CatalogMutationLatch = CatalogMutationLatch::new();

pub(super) struct CatalogMutationLatch {
    unknown: AtomicBool,
}

impl CatalogMutationLatch {
    pub(super) const fn new() -> Self {
        Self {
            unknown: AtomicBool::new(false),
        }
    }

    pub(super) fn mark_unknown(&self) {
        self.unknown.store(true, Ordering::SeqCst);
    }

    pub(super) fn permits_durable_replay(&self) -> bool {
        !self.unknown.load(Ordering::SeqCst)
    }
}

pub(super) fn catalog_mutation_replay_is_safe() -> bool {
    CATALOG_MUTATION_UNKNOWN.permits_durable_replay()
}

fn mark_catalog_mutation_unknown() {
    #[cfg(windows)]
    CATALOG_MUTATION_UNKNOWN.mark_unknown();
}

pub(super) enum CatalogWriteError {
    BeforeReplace(WorkspaceNativeError),
    AfterReplaceUnknown,
}

impl From<CatalogWriteError> for WorkspaceNativeError {
    fn from(error: CatalogWriteError) -> Self {
        match error {
            CatalogWriteError::BeforeReplace(error) => error,
            CatalogWriteError::AfterReplaceUnknown => Self::AuthorityMutationUnknown,
        }
    }
}

pub(crate) fn prepare_authority_directory(path: &Path) -> Result<(), WorkspaceNativeError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(WorkspaceNativeError::AuthorityInvalid);
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt as _;
                builder.mode(0o700);
            }
            builder
                .create(path)
                .map_err(|_| WorkspaceNativeError::AuthorityUnavailable)?;
        }
        Err(_) => return Err(WorkspaceNativeError::AuthorityInvalid),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| WorkspaceNativeError::AuthorityUnavailable)?;
        let mode = fs::symlink_metadata(path)
            .map_err(|_| WorkspaceNativeError::AuthorityInvalid)?
            .permissions()
            .mode()
            & 0o777;
        if mode != 0o700 {
            return Err(WorkspaceNativeError::AuthorityInvalid);
        }
    }
    Ok(())
}

pub(super) fn read_catalog<T: DeserializeOwned>(
    path: &Path,
) -> Result<Option<T>, WorkspaceNativeError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(WorkspaceNativeError::AuthorityInvalid),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_CATALOG_BYTES
    {
        return Err(WorkspaceNativeError::AuthorityInvalid);
    }
    #[cfg(unix)]
    validate_file_mode(&metadata)?;
    let file_fence = CatalogFileFence::capture(path, &metadata)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|_| WorkspaceNativeError::AuthorityInvalid)?;
    let opened_metadata = file
        .metadata()
        .map_err(|_| WorkspaceNativeError::AuthorityInvalid)?;
    if !opened_metadata.is_file()
        || opened_metadata.len() != metadata.len()
        || !file_fence.matches(path, &file, &opened_metadata)
    {
        return Err(WorkspaceNativeError::AuthorityInvalid);
    }
    #[cfg(unix)]
    validate_file_mode(&opened_metadata)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| WorkspaceNativeError::AuthorityInvalid)?;
    let completed_metadata = file
        .metadata()
        .map_err(|_| WorkspaceNativeError::AuthorityInvalid)?;
    if bytes.is_empty()
        || bytes.len() as u64 > MAX_CATALOG_BYTES
        || completed_metadata.len() != bytes.len() as u64
        || !file_fence.matches(path, &file, &completed_metadata)
        || !same_file_version(&opened_metadata, &completed_metadata)
    {
        return Err(WorkspaceNativeError::AuthorityInvalid);
    }
    #[cfg(unix)]
    validate_file_mode(&completed_metadata)?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| WorkspaceNativeError::AuthorityInvalid)
}

pub(super) fn catalog_file_identity(path: &Path) -> Result<CatalogFileFence, WorkspaceNativeError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| WorkspaceNativeError::AuthorityInvalid)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(WorkspaceNativeError::AuthorityInvalid);
    }
    CatalogFileFence::capture(path, &metadata)
}

#[cfg(unix)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct CatalogFileFence {
    device: u64,
    inode: u64,
}

#[cfg(unix)]
impl CatalogFileFence {
    fn capture(_path: &Path, metadata: &fs::Metadata) -> Result<Self, WorkspaceNativeError> {
        use std::os::unix::fs::MetadataExt as _;
        Ok(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }

    fn matches(&self, path: &Path, _file: &File, opened: &fs::Metadata) -> bool {
        use std::os::unix::fs::MetadataExt as _;
        let current = match fs::symlink_metadata(path) {
            Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => metadata,
            Ok(_) | Err(_) => return false,
        };
        opened.dev() == self.device
            && opened.ino() == self.inode
            && current.dev() == self.device
            && current.ino() == self.inode
    }
}

#[cfg(unix)]
pub(super) fn same_file_identity(before: &fs::Metadata, opened: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt as _;
    before.dev() == opened.dev() && before.ino() == opened.ino()
}

#[cfg(unix)]
fn same_file_version(before: &fs::Metadata, completed: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt as _;
    before.len() == completed.len()
        && before.mtime() == completed.mtime()
        && before.mtime_nsec() == completed.mtime_nsec()
        && before.ctime() == completed.ctime()
        && before.ctime_nsec() == completed.ctime_nsec()
}

#[cfg(windows)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct CatalogFileFence {
    volume_serial_number: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[cfg(windows)]
impl CatalogFileFence {
    fn capture(path: &Path, _metadata: &fs::Metadata) -> Result<Self, WorkspaceNativeError> {
        windows_path_identity(path)
    }

    fn matches(&self, path: &Path, file: &File, _opened: &fs::Metadata) -> bool {
        windows_file_identity(file).is_ok_and(|identity| identity == *self)
            && windows_path_identity(path).is_ok_and(|identity| identity == *self)
    }
}

#[cfg(windows)]
fn same_file_version(before: &fs::Metadata, completed: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    before.file_size() == completed.file_size()
        && before.last_write_time() == completed.last_write_time()
}

#[cfg(windows)]
fn windows_path_identity(path: &Path) -> Result<CatalogFileFence, WorkspaceNativeError> {
    use std::os::windows::fs::MetadataExt as _;
    use std::os::windows::fs::OpenOptionsExt as _;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;

    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    let file = options
        .open(path)
        .map_err(|_| WorkspaceNativeError::AuthorityInvalid)?;
    let metadata = file
        .metadata()
        .map_err(|_| WorkspaceNativeError::AuthorityInvalid)?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(WorkspaceNativeError::AuthorityInvalid);
    }
    windows_file_identity(&file)
}

#[cfg(windows)]
fn windows_file_identity(file: &File) -> Result<CatalogFileFence, WorkspaceNativeError> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandle;
    use windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION;

    let mut information = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    let read =
        unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, information.as_mut_ptr()) };
    if read == 0 {
        return Err(WorkspaceNativeError::AuthorityInvalid);
    }
    let information = unsafe { information.assume_init() };
    Ok(CatalogFileFence {
        volume_serial_number: information.dwVolumeSerialNumber,
        file_index_high: information.nFileIndexHigh,
        file_index_low: information.nFileIndexLow,
    })
}

pub(super) fn write_catalog<T: Serialize>(
    directory: &Path,
    path: &Path,
    authority: &T,
) -> Result<(), CatalogWriteError> {
    write_catalog_with_sync(directory, path, authority, sync_directory)
}

pub(super) fn write_catalog_with_sync<T: Serialize>(
    directory: &Path,
    path: &Path,
    authority: &T,
    sync: impl FnOnce(&Path) -> Result<(), WorkspaceNativeError>,
) -> Result<(), CatalogWriteError> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(CatalogWriteError::BeforeReplace(
                WorkspaceNativeError::AuthorityInvalid,
            ));
        }
    }
    let bytes = serde_json::to_vec(authority)
        .map_err(|_| CatalogWriteError::BeforeReplace(WorkspaceNativeError::AuthorityInvalid))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_CATALOG_BYTES {
        return Err(CatalogWriteError::BeforeReplace(
            WorkspaceNativeError::AuthorityInvalid,
        ));
    }
    let temporary_path =
        temporary_catalog_path(directory).map_err(CatalogWriteError::BeforeReplace)?;
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut temporary = options.open(&temporary_path).map_err(|_| {
        CatalogWriteError::BeforeReplace(WorkspaceNativeError::AuthorityUnavailable)
    })?;
    let written = temporary
        .write_all(&bytes)
        .and_then(|()| temporary.sync_all());
    if written.is_err() {
        let _ = fs::remove_file(&temporary_path);
        return Err(CatalogWriteError::BeforeReplace(
            WorkspaceNativeError::AuthorityUnavailable,
        ));
    }
    drop(temporary);
    if replace_catalog(&temporary_path, path).is_err() {
        let _ = fs::remove_file(&temporary_path);
        mark_catalog_mutation_unknown();
        return Err(CatalogWriteError::AfterReplaceUnknown);
    }
    sync(directory).map_err(|_| {
        mark_catalog_mutation_unknown();
        CatalogWriteError::AfterReplaceUnknown
    })
}

#[cfg(unix)]
fn validate_file_mode(metadata: &fs::Metadata) -> Result<(), WorkspaceNativeError> {
    use std::os::unix::fs::PermissionsExt as _;
    if metadata.permissions().mode() & 0o777 != 0o600 {
        return Err(WorkspaceNativeError::AuthorityInvalid);
    }
    Ok(())
}

fn temporary_catalog_path(directory: &Path) -> Result<PathBuf, WorkspaceNativeError> {
    let mut bytes = [0_u8; 8];
    getrandom::fill(&mut bytes).map_err(|_| WorkspaceNativeError::AuthorityUnavailable)?;
    Ok(directory.join(format!(".workspace-authority-{}.tmp", hex::encode(bytes))))
}

pub(super) fn sync_directory(directory: &Path) -> Result<(), WorkspaceNativeError> {
    #[cfg(unix)]
    File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|_| WorkspaceNativeError::AuthorityUnavailable)?;
    Ok(())
}

#[cfg(not(windows))]
fn replace_catalog(temporary_path: &Path, path: &Path) -> std::io::Result<()> {
    fs::rename(temporary_path, path)
}

#[cfg(windows)]
fn replace_catalog(temporary_path: &Path, path: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    use windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING;
    use windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH;

    let temporary = temporary_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // MOVEFILE_WRITE_THROUGH is the Windows durability equivalent of the Unix
    // rename followed by parent-directory fsync below.
    let moved = unsafe {
        MoveFileExW(
            temporary.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
