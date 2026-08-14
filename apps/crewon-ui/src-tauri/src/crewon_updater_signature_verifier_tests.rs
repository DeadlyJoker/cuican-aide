use std::ffi::OsString;
use std::fs;

use pretty_assertions::assert_eq;
use tempfile::tempdir;

use super::run;

const PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\n\
RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\n\
RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\n\
trusted comment: timestamp:1556193335\tfile:test\n\
y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n";

#[test]
fn verifies_prehashed_updater_artifact_from_files() {
    let fixture = fixture(b"test");

    assert_eq!(run(fixture.arguments()), Ok(()));
}

#[test]
fn rejects_tampered_updater_artifact() {
    let fixture = fixture(b"tampered");

    assert_eq!(
        run(fixture.arguments()),
        Err("desktop_updater_signature_invalid")
    );
}

#[test]
fn rejects_incomplete_command_line() {
    assert_eq!(
        run([OsString::from("public-key-only")]),
        Err("usage: crewon-updater-signature-verifier <public-key> <artifact> <signature>")
    );
}

struct Fixture {
    _directory: tempfile::TempDir,
    public_key: OsString,
    artifact: OsString,
    signature: OsString,
}

impl Fixture {
    fn arguments(&self) -> [OsString; 3] {
        [
            self.public_key.clone(),
            self.artifact.clone(),
            self.signature.clone(),
        ]
    }
}

fn fixture(artifact_bytes: &[u8]) -> Fixture {
    let directory = tempdir().expect("create verifier fixture directory");
    let public_key = directory.path().join("updater.pub");
    let artifact = directory.path().join("updater.tar.gz");
    let signature = directory.path().join("updater.tar.gz.sig");
    fs::write(&public_key, PUBLIC_KEY).expect("write public key fixture");
    fs::write(&artifact, artifact_bytes).expect("write artifact fixture");
    fs::write(&signature, SIGNATURE).expect("write signature fixture");
    Fixture {
        _directory: directory,
        public_key: public_key.into_os_string(),
        artifact: artifact.into_os_string(),
        signature: signature.into_os_string(),
    }
}
