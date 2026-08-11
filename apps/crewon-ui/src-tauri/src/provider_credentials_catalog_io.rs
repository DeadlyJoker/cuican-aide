use std::fs;
use std::fs::OpenOptions;
use std::io::Read;
use std::io::Write;
use std::path::Path;

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::provider_credentials::validate_catalog;
use crate::provider_credentials::ProviderCredentialCatalogFile;
use crate::provider_credentials::ProviderCredentialError;
use crate::provider_credentials::MAX_CATALOG_BYTES;

pub(super) fn read_catalog(
    path: &Path,
) -> Result<ProviderCredentialCatalogFile, ProviderCredentialError> {
    let mut file = match OpenOptions::new().read(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Default::default()),
        Err(_) => return Err(ProviderCredentialError::CatalogInvalid),
    };
    let metadata = file
        .metadata()
        .map_err(|_| ProviderCredentialError::CatalogInvalid)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_CATALOG_BYTES {
        return Err(ProviderCredentialError::CatalogInvalid);
    }
    let mut encoded = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut encoded)
        .map_err(|_| ProviderCredentialError::CatalogInvalid)?;
    serde_json::from_slice(&encoded).map_err(|_| ProviderCredentialError::CatalogInvalid)
}

pub(super) fn write_catalog(
    path: &Path,
    catalog: &ProviderCredentialCatalogFile,
) -> Result<(), ProviderCredentialError> {
    validate_catalog(catalog)?;
    write_secure_json(path, catalog)
}

pub(super) fn read_optional_secure_json<T: DeserializeOwned>(
    path: &Path,
) -> Result<Option<T>, ProviderCredentialError> {
    let mut file = match OpenOptions::new().read(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ProviderCredentialError::CatalogInvalid),
    };
    let metadata = file
        .metadata()
        .map_err(|_| ProviderCredentialError::CatalogInvalid)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_CATALOG_BYTES {
        return Err(ProviderCredentialError::CatalogInvalid);
    }
    let mut encoded = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut encoded)
        .map_err(|_| ProviderCredentialError::CatalogInvalid)?;
    serde_json::from_slice(&encoded)
        .map(Some)
        .map_err(|_| ProviderCredentialError::CatalogInvalid)
}

pub(super) fn write_secure_json<T: Serialize>(
    path: &Path,
    value: &T,
) -> Result<(), ProviderCredentialError> {
    let encoded = serde_json::to_vec(value).map_err(|_| ProviderCredentialError::CatalogInvalid)?;
    if encoded.is_empty() || encoded.len() as u64 > MAX_CATALOG_BYTES {
        return Err(ProviderCredentialError::CatalogInvalid);
    }
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(ProviderCredentialError::CatalogInvalid);
    }
    let parent = path
        .parent()
        .ok_or(ProviderCredentialError::CatalogInvalid)?;
    let suffix = hex::encode(
        getrandom::u64()
            .map_err(|_| ProviderCredentialError::CatalogInvalid)?
            .to_be_bytes(),
    );
    let temporary_path = parent.join(format!(".provider-credentials-{suffix}.tmp"));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary_path)
        .map_err(|_| ProviderCredentialError::CatalogInvalid)?;
    if file
        .write_all(&encoded)
        .and_then(|()| file.sync_all())
        .is_err()
    {
        let _ = fs::remove_file(&temporary_path);
        return Err(ProviderCredentialError::CatalogInvalid);
    }
    drop(file);
    if replace_catalog_file(&temporary_path, path).is_err() {
        let _ = fs::remove_file(&temporary_path);
        return Err(ProviderCredentialError::CatalogInvalid);
    }
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ProviderCredentialError::CatalogInvalid)?;
    Ok(())
}

pub(super) fn remove_secure_file(path: &Path) -> Result<(), ProviderCredentialError> {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(ProviderCredentialError::CatalogInvalid),
    }
    #[cfg(unix)]
    fs::File::open(
        path.parent()
            .ok_or(ProviderCredentialError::CatalogInvalid)?,
    )
    .and_then(|directory| directory.sync_all())
    .map_err(|_| ProviderCredentialError::CatalogInvalid)?;
    Ok(())
}

#[cfg(not(windows))]
fn replace_catalog_file(temporary_path: &Path, path: &Path) -> std::io::Result<()> {
    fs::rename(temporary_path, path)
}

#[cfg(windows)]
fn replace_catalog_file(temporary_path: &Path, path: &Path) -> std::io::Result<()> {
    let backup_path = path.with_extension("json.backup");
    let had_catalog = path.exists();
    if had_catalog {
        if backup_path.exists() {
            fs::remove_file(&backup_path)?;
        }
        fs::rename(path, &backup_path)?;
    }
    if let Err(error) = fs::rename(temporary_path, path) {
        if had_catalog {
            let _ = fs::rename(&backup_path, path);
        }
        return Err(error);
    }
    if had_catalog {
        fs::remove_file(backup_path)?;
    }
    Ok(())
}

pub(crate) fn restrict_directory(path: &Path) -> Result<(), ProviderCredentialError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| ProviderCredentialError::CatalogInvalid)?;
    }
    Ok(())
}
