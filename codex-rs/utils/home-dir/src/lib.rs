use crewon_utils_absolute_path::AbsolutePathBuf;
use dirs::home_dir;
use std::io::ErrorKind;
use std::path::Path;
use std::path::PathBuf;

const CREWON_HOME_ENV: &str = "CREWON_HOME";
const LEGACY_CODEX_HOME_ENV: &str = "CODEX_HOME";
const CREWON_HOME_DIR: &str = ".crewon";
const LEGACY_CODEX_HOME_DIR: &str = ".codex";

/// Returns the path to the Crewon configuration directory.
///
/// `CREWON_HOME` takes precedence. If it is not set, the legacy `CODEX_HOME`
/// value is honored. If neither variable is set, this returns `~/.crewon`, or
/// an existing `~/.codex` directory as a compatibility fallback.
pub fn find_crewon_home() -> std::io::Result<AbsolutePathBuf> {
    let crewon_home_env = std::env::var(CREWON_HOME_ENV)
        .ok()
        .filter(|val| !val.is_empty());
    let legacy_codex_home_env = std::env::var(LEGACY_CODEX_HOME_ENV)
        .ok()
        .filter(|val| !val.is_empty());
    find_crewon_home_from_env(crewon_home_env.as_deref(), legacy_codex_home_env.as_deref())
}

/// Legacy compatibility wrapper. Prefer [`find_crewon_home`] in new code.
pub fn find_codex_home() -> std::io::Result<AbsolutePathBuf> {
    find_crewon_home()
}

fn find_crewon_home_from_env(
    crewon_home_env: Option<&str>,
    legacy_codex_home_env: Option<&str>,
) -> std::io::Result<AbsolutePathBuf> {
    find_crewon_home_from_env_with_home_dir(crewon_home_env, legacy_codex_home_env, home_dir())
}

fn find_crewon_home_from_env_with_home_dir(
    crewon_home_env: Option<&str>,
    legacy_codex_home_env: Option<&str>,
    home_dir: Option<PathBuf>,
) -> std::io::Result<AbsolutePathBuf> {
    if let Some(val) = crewon_home_env {
        return resolve_home_env(CREWON_HOME_ENV, val);
    }
    if let Some(val) = legacy_codex_home_env {
        return resolve_home_env(LEGACY_CODEX_HOME_ENV, val);
    }

    let home_dir = home_dir
        .ok_or_else(|| std::io::Error::new(ErrorKind::NotFound, "Could not find home directory"))?;
    let crewon_home = home_dir.join(CREWON_HOME_DIR);
    let legacy_codex_home = home_dir.join(LEGACY_CODEX_HOME_DIR);
    let selected_home = if crewon_home.exists() || !legacy_codex_home.exists() {
        crewon_home
    } else {
        legacy_codex_home
    };
    AbsolutePathBuf::from_absolute_path(selected_home)
}

fn resolve_home_env(env_name: &str, val: &str) -> std::io::Result<AbsolutePathBuf> {
    let path = PathBuf::from(val);
    let metadata = std::fs::metadata(&path).map_err(|err| match err.kind() {
        ErrorKind::NotFound => std::io::Error::new(
            ErrorKind::NotFound,
            format!("{env_name} points to {val:?}, but that path does not exist"),
        ),
        _ => std::io::Error::new(
            err.kind(),
            format!("failed to read {env_name} {val:?}: {err}"),
        ),
    })?;

    if !metadata.is_dir() {
        Err(std::io::Error::new(
            ErrorKind::InvalidInput,
            format!("{env_name} points to {val:?}, but that path is not a directory"),
        ))
    } else {
        canonical_absolute_path(&path).map_err(|err| {
            std::io::Error::new(
                err.kind(),
                format!("failed to canonicalize {env_name} {val:?}: {err}"),
            )
        })
    }
}

fn canonical_absolute_path(path: &Path) -> std::io::Result<AbsolutePathBuf> {
    AbsolutePathBuf::from_absolute_path(path.canonicalize()?)
}

#[cfg(test)]
mod tests {
    use super::find_codex_home;
    use super::find_crewon_home_from_env;
    use super::find_crewon_home_from_env_with_home_dir;
    use crewon_utils_absolute_path::AbsolutePathBuf;
    use pretty_assertions::assert_eq;
    use std::fs;
    use std::io::ErrorKind;
    use tempfile::TempDir;

    #[test]
    fn find_crewon_home_env_missing_path_is_fatal() {
        let temp_home = TempDir::new().expect("temp home");
        let missing = temp_home.path().join("missing-crewon-home");
        let missing_str = missing
            .to_str()
            .expect("missing crewon home path should be valid utf-8");

        let err =
            find_crewon_home_from_env(Some(missing_str), None).expect_err("missing CREWON_HOME");
        assert_eq!(err.kind(), ErrorKind::NotFound);
        assert!(
            err.to_string().contains("CREWON_HOME"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn find_crewon_home_env_file_path_is_fatal() {
        let temp_home = TempDir::new().expect("temp home");
        let file_path = temp_home.path().join("crewon-home.txt");
        fs::write(&file_path, "not a directory").expect("write temp file");
        let file_str = file_path
            .to_str()
            .expect("file crewon home path should be valid utf-8");

        let err = find_crewon_home_from_env(Some(file_str), None).expect_err("file CREWON_HOME");
        assert_eq!(err.kind(), ErrorKind::InvalidInput);
        assert!(
            err.to_string().contains("not a directory"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn find_crewon_home_env_valid_directory_canonicalizes() {
        let temp_home = TempDir::new().expect("temp home");
        let temp_str = temp_home
            .path()
            .to_str()
            .expect("temp crewon home path should be valid utf-8");

        let resolved = find_crewon_home_from_env(Some(temp_str), None).expect("valid CREWON_HOME");
        let expected = temp_home
            .path()
            .canonicalize()
            .expect("canonicalize temp home");
        let expected = AbsolutePathBuf::from_absolute_path(expected).expect("absolute home");
        assert_eq!(resolved, expected);
    }

    #[test]
    fn find_crewon_home_env_takes_precedence_over_legacy_codex_home() {
        let crewon_home = TempDir::new().expect("crewon home");
        let codex_home = TempDir::new().expect("crewon home");
        let crewon_home_str = crewon_home
            .path()
            .to_str()
            .expect("crewon home should be valid utf-8");
        let codex_home_str = codex_home
            .path()
            .to_str()
            .expect("crewon home should be valid utf-8");

        let resolved = find_crewon_home_from_env(Some(crewon_home_str), Some(codex_home_str))
            .expect("valid CREWON_HOME");
        let expected = crewon_home
            .path()
            .canonicalize()
            .expect("canonicalize crewon home");
        let expected = AbsolutePathBuf::from_absolute_path(expected).expect("absolute home");
        assert_eq!(resolved, expected);
    }

    #[test]
    fn find_crewon_home_uses_legacy_codex_home_env_when_crewon_home_is_absent() {
        let codex_home = TempDir::new().expect("crewon home");
        let codex_home_str = codex_home
            .path()
            .to_str()
            .expect("crewon home should be valid utf-8");

        let resolved =
            find_crewon_home_from_env(/*crewon_home_env*/ None, Some(codex_home_str))
                .expect("valid CODEX_HOME");
        let expected = codex_home
            .path()
            .canonicalize()
            .expect("canonicalize crewon home");
        let expected = AbsolutePathBuf::from_absolute_path(expected).expect("absolute home");
        assert_eq!(resolved, expected);
    }

    #[test]
    fn find_crewon_home_without_env_uses_default_crewon_home_dir() {
        let temp_home = TempDir::new().expect("temp home");
        let resolved = find_crewon_home_from_env_with_home_dir(
            /*crewon_home_env*/ None,
            /*legacy_codex_home_env*/ None,
            Some(temp_home.path().to_path_buf()),
        )
        .expect("default CREWON_HOME");
        let expected = temp_home.path().join(".crewon");
        let expected = AbsolutePathBuf::from_absolute_path(expected).expect("absolute home");
        assert_eq!(resolved, expected);
    }

    #[test]
    fn find_crewon_home_without_env_uses_existing_legacy_codex_home_dir() {
        let temp_home = TempDir::new().expect("temp home");
        let legacy_codex_home = temp_home.path().join(".codex");
        fs::create_dir(&legacy_codex_home).expect("create legacy home");

        let resolved = find_crewon_home_from_env_with_home_dir(
            /*crewon_home_env*/ None,
            /*legacy_codex_home_env*/ None,
            Some(temp_home.path().to_path_buf()),
        )
        .expect("legacy CODEX_HOME fallback");
        let expected =
            AbsolutePathBuf::from_absolute_path(legacy_codex_home).expect("absolute home");
        assert_eq!(resolved, expected);
    }

    #[test]
    fn find_crewon_home_prefers_existing_crewon_home_over_existing_legacy_codex_home_dir() {
        let temp_home = TempDir::new().expect("temp home");
        fs::create_dir(temp_home.path().join(".codex")).expect("create legacy home");
        let crewon_home = temp_home.path().join(".crewon");
        fs::create_dir(&crewon_home).expect("create crewon home");

        let resolved = find_crewon_home_from_env_with_home_dir(
            /*crewon_home_env*/ None,
            /*legacy_codex_home_env*/ None,
            Some(temp_home.path().to_path_buf()),
        )
        .expect("crewon home");
        let expected = AbsolutePathBuf::from_absolute_path(crewon_home).expect("absolute home");
        assert_eq!(resolved, expected);
    }

    #[test]
    fn legacy_find_codex_home_wrapper_uses_crewon_resolution() {
        let _ = find_codex_home;
    }
}
