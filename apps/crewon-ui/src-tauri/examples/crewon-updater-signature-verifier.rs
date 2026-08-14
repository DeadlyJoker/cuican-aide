use std::env;
use std::ffi::OsString;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use minisign_verify::PublicKey;
use minisign_verify::Signature;

const READ_BUFFER_SIZE: usize = 64 * 1024;

fn verify_updater_signature(
    public_key_path: &Path,
    artifact_path: &Path,
    signature_path: &Path,
) -> Result<(), &'static str> {
    let public_key =
        PublicKey::from_file(public_key_path).map_err(|_| "desktop_updater_public_key_invalid")?;
    let signature =
        Signature::from_file(signature_path).map_err(|_| "desktop_updater_signature_invalid")?;
    let mut verifier = public_key
        .verify_stream(&signature)
        .map_err(|_| "desktop_updater_signature_invalid")?;
    let mut artifact =
        File::open(artifact_path).map_err(|_| "desktop_updater_artifact_unreadable")?;
    let mut buffer = [0_u8; READ_BUFFER_SIZE];

    loop {
        let bytes_read = artifact
            .read(&mut buffer)
            .map_err(|_| "desktop_updater_artifact_unreadable")?;
        if bytes_read == 0 {
            break;
        }
        verifier.update(&buffer[..bytes_read]);
    }

    verifier
        .finalize()
        .map_err(|_| "desktop_updater_signature_invalid")
}

fn run(args: impl IntoIterator<Item = OsString>) -> Result<(), &'static str> {
    let paths = args.into_iter().collect::<Vec<_>>();
    let [public_key, artifact, signature] = paths.as_slice() else {
        return Err("usage: crewon-updater-signature-verifier <public-key> <artifact> <signature>");
    };
    verify_updater_signature(
        Path::new(public_key),
        Path::new(artifact),
        Path::new(signature),
    )
}

fn main() {
    if let Err(error) = run(env::args_os().skip(1)) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
#[path = "../src/crewon_updater_signature_verifier_tests.rs"]
mod tests;
