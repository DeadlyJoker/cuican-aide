use std::ffi::OsString;

use pretty_assertions::assert_eq;

use super::GuardianError;
use super::Invocation;
use super::parse_invocation;

#[test]
fn parses_only_bounded_server_owned_target_arguments() {
    let parsed = parse_invocation([
        OsString::from("guardian"),
        OsString::from("--"),
        OsString::from("/runtime/node"),
        OsString::from("worker.mjs"),
    ])
    .unwrap();
    match parsed {
        Invocation::Guardian(target) => {
            assert_eq!(target.program, OsString::from("/runtime/node"));
            assert_eq!(target.arguments, vec![OsString::from("worker.mjs")]);
        }
        #[cfg(unix)]
        Invocation::Watchdog { .. } => panic!("expected guardian invocation"),
    }
}

#[test]
fn rejects_missing_and_unbounded_target_arguments() {
    assert_eq!(
        parse_invocation([OsString::from("guardian"), OsString::from("--")]).unwrap_err(),
        GuardianError::ArgumentInvalid
    );
    let mut arguments = vec![OsString::from("guardian"), OsString::from("--")];
    arguments.extend((0..=65).map(|index| OsString::from(format!("arg-{index}"))));
    assert_eq!(
        parse_invocation(arguments).unwrap_err(),
        GuardianError::ArgumentInvalid
    );
}
