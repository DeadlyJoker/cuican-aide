//! Regression coverage for the design-studio contrast math.
//!
//! The design scene's quality gate is `audit_design.py`, and its verdict is only
//! as trustworthy as its color math. Treating a tinted badge such as
//! `rgba(76, 183, 130, 0.14)` as an opaque fill reported 1.4:1 for text that
//! actually sits at 8.6:1 once composited over the surface behind it — eight
//! false failures on a compliant artifact, which trains callers to ignore the
//! gate entirely.
//!
//! These cases run the shipped module through the system `python3` so the
//! shipped file, not a copy, is what gets checked. `contrast.py` is stdlib-only
//! by design, so no skill venv is needed here.

use std::process::Command;

use pretty_assertions::assert_eq;

/// The `scripts/` directory holding the shipped `designlib`, resolved via Cargo/Bazel runfiles.
///
/// `find_resource!` is crate-relative and returns a path without checking it
/// exists, so the assertion below is what turns an asset move into a clear
/// failure instead of a confusing `ModuleNotFoundError` from python3.
fn scripts_dir() -> std::path::PathBuf {
    const RESOURCE: &str = "src/assets/samples/design-studio/scripts/designlib/contrast.py";
    let contrast_py = crewon_utils_cargo_bin::find_resource!(RESOURCE)
        .unwrap_or_else(|err| panic!("resolve {RESOURCE}: {err}"));
    assert!(
        contrast_py.is_file(),
        "design-studio contrast.py not found at {contrast_py:?}"
    );
    contrast_py
        .parent()
        .and_then(std::path::Path::parent)
        .expect("contrast.py sits under scripts/designlib/")
        .to_path_buf()
}

/// Runs a snippet with `designlib` importable and returns its trimmed stdout.
fn run_python(body: &str) -> String {
    let scripts = scripts_dir();
    let program = format!("import sys; sys.path.insert(0, {scripts:?})\n{body}");
    let output = Command::new("python3")
        .arg("-c")
        .arg(&program)
        .output()
        .expect("spawn python3");
    assert!(
        output.status.success(),
        "python3 failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

#[test]
fn parses_alpha_from_every_supported_color_syntax() {
    let reported = run_python(
        r##"
from designlib.contrast import parse_color_alpha
for value in ["#7fd3a6", "#7fd3a680", "rgb(76 183 130 / .14)",
              "rgba(17, 17, 17, 0.15)", "hsl(210 100% 50% / 50%)", "transparent"]:
    rgb, alpha = parse_color_alpha(value)
    print(f"{value} -> {rgb} a={alpha:.3f}")
"##,
    );

    assert_eq!(
        reported,
        "\
#7fd3a6 -> (127, 211, 166) a=1.000
#7fd3a680 -> (127, 211, 166) a=0.502
rgb(76 183 130 / .14) -> (76, 183, 130) a=0.140
rgba(17, 17, 17, 0.15) -> (17, 17, 17) a=0.150
hsl(210 100% 50% / 50%) -> (0, 128, 255) a=0.500
transparent -> (0, 0, 0) a=0.000"
    );
}

#[test]
fn composites_tinted_layers_before_measuring_contrast() {
    let reported = run_python(
        r##"
from designlib.contrast import composite, contrast_ratio, parse_color_alpha, wcag_level

def measure(fg, layers):
    base = parse_color_alpha(layers[-1])[0]
    for layer in reversed(layers[:-1]):
        base = composite(parse_color_alpha(layer), base)
    ink = composite(parse_color_alpha(fg), base)
    ratio = contrast_ratio(ink, base)
    return round(ratio, 2), wcag_level(ratio, large_text=False)

# A 14%-opacity success badge on the dark surface: compliant once composited.
print(measure("#7fd3a6", ["rgb(76 183 130 / .14)", "#101113"]))
# Near-black text at 15% opacity on white: genuinely unreadable.
print(measure("rgba(17,17,17,0.15)", ["#ffffff"]))
# Opaque light grey on white: the classic real failure, still caught.
print(measure("#cccccc", ["#ffffff"]))
"##,
    );

    assert_eq!(
        reported,
        "\
(8.61, 'AAA')
(1.38, 'FAIL')
(1.61, 'FAIL')"
    );
}
