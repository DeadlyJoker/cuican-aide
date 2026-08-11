use std::ffi::OsStr;
use std::process::Command;

use pretty_assertions::assert_eq;

use super::encode_frame;
use super::exit_code_proves_cleanup;
use super::GuardianFrameKind;
use super::GuardianTarget;

#[test]
fn guardian_frames_are_canonical_bounded_and_distinguish_each_phase() {
    let cases = [
        (
            GuardianFrameKind::BootstrapInput,
            1_u8,
            b"secret".as_slice(),
        ),
        (GuardianFrameKind::Input, 2_u8, b"activate\n".as_slice()),
        (GuardianFrameKind::Shutdown, 3_u8, b"".as_slice()),
    ];
    for (kind, tag, payload) in cases {
        let encoded = encode_frame(kind, payload).unwrap();
        assert_eq!(&encoded[..4], b"CRWG");
        assert_eq!(encoded[4..8], [0, tag, 0, 0]);
        assert_eq!(
            &encoded[8..12],
            &u32::try_from(payload.len()).unwrap().to_be_bytes()
        );
        assert_eq!(&encoded[12..], payload);
    }
    assert!(encode_frame(GuardianFrameKind::Input, &vec![0; 64 * 1024 + 1]).is_err());
    assert!(encode_frame(GuardianFrameKind::Shutdown, b"not-empty").is_err());
    assert_eq!(
        [
            exit_code_proves_cleanup(Some(0)),
            exit_code_proves_cleanup(Some(10)),
            exit_code_proves_cleanup(Some(20)),
            exit_code_proves_cleanup(Some(70)),
            exit_code_proves_cleanup(None),
        ],
        [true, true, true, false, false]
    );
}

#[test]
fn target_projection_is_exact_but_debug_redacts_argv_environment_and_cwd() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("secret-cwd");
    std::fs::create_dir(&cwd).unwrap();
    let mut command = Command::new("/secret/program");
    command
        .arg("secret-argument")
        .env_clear()
        .env("SECRET_KEY", "secret-value")
        .current_dir(&cwd);

    let target = GuardianTarget::from_command(&command).unwrap();
    let debug = format!("{target:?}");
    assert_eq!(debug, "GuardianTarget([REDACTED])");
    for secret in [
        "/secret/program",
        "secret-argument",
        "SECRET_KEY",
        "secret-value",
        cwd.to_str().unwrap(),
    ] {
        assert!(!debug.contains(secret));
    }
}

#[test]
fn target_projection_rejects_relative_cwd_and_unbounded_argv() {
    let mut relative = Command::new("/bin/echo");
    relative.current_dir("relative");
    assert!(GuardianTarget::from_command(&relative).is_err());

    let root = tempfile::tempdir().unwrap();
    let mut too_many = Command::new("/bin/echo");
    too_many
        .current_dir(root.path())
        .args((0..65).map(|index| format!("argument-{index}")));
    assert!(GuardianTarget::from_command(&too_many).is_err());

    let mut removed_environment = Command::new(OsStr::new("/bin/echo"));
    removed_environment
        .current_dir(root.path())
        .env_remove("PATH");
    assert!(GuardianTarget::from_command(&removed_environment).is_err());
}
