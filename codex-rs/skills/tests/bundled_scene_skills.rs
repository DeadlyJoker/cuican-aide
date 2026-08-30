//! Verifies the bundled scene skills install to disk and stay loadable.
//!
//! The office and design scenes point the model at these skills by name, so a
//! rename or a dropped asset would silently degrade those scenes' deliverables.
//! This test installs into a temp `CODEX_HOME` and asserts the contract the
//! scenes depend on: the skill directory, its `SKILL.md` frontmatter name, and
//! the scripts the instructions tell the model to run.
//!
//! The code scene is absent on purpose — it uses the platform's own shell and
//! editing tools rather than a skill. See `crewon-scene-runtime`'s `skill_hints`.

use std::fs;
use std::path::Path;

use crewon_utils_absolute_path::AbsolutePathBuf;
use pretty_assertions::assert_eq;
use tempfile::TempDir;

/// `(skill directory, frontmatter name, scripts the SKILL.md promises)`
const BUNDLED_SCENE_SKILLS: &[(&str, &str, &[&str])] = &[
    (
        "office-suite",
        "office-suite",
        &[
            "build_docx.py",
            "build_pptx.py",
            "build_xlsx.py",
            "read_office.py",
            "validate_office.py",
        ],
    ),
    (
        "design-studio",
        "design-studio",
        &["render_design.py", "audit_design.py"],
    ),
];

fn install() -> (TempDir, AbsolutePathBuf) {
    let temp = TempDir::new().expect("create temp codex home");
    let codex_home =
        AbsolutePathBuf::try_from(temp.path().to_path_buf()).expect("temp path is absolute");
    crewon_skills::install_system_skills(&codex_home).expect("install system skills");
    let root = crewon_skills::system_cache_root_dir(&codex_home);
    (temp, root)
}

fn frontmatter_name(skill_md: &Path) -> String {
    let contents = fs::read_to_string(skill_md).expect("read SKILL.md");
    contents
        .lines()
        .find_map(|line| line.strip_prefix("name:"))
        .map(|value| value.trim().trim_matches('"').to_string())
        .unwrap_or_default()
}

#[test]
fn bundled_scene_skills_install_with_their_scripts() {
    let (_temp, root) = install();

    let installed: Vec<(String, String, Vec<String>)> = BUNDLED_SCENE_SKILLS
        .iter()
        .map(|(directory, _, scripts)| {
            let skill_dir = root.as_path().join(directory);
            let name = frontmatter_name(&skill_dir.join("SKILL.md"));
            let present = scripts
                .iter()
                .filter(|script| skill_dir.join("scripts").join(script).is_file())
                .map(|script| (*script).to_string())
                .collect();
            (directory.to_string(), name, present)
        })
        .collect();

    let expected: Vec<(String, String, Vec<String>)> = BUNDLED_SCENE_SKILLS
        .iter()
        .map(|(directory, name, scripts)| {
            (
                directory.to_string(),
                name.to_string(),
                scripts.iter().map(|script| (*script).to_string()).collect(),
            )
        })
        .collect();

    assert_eq!(installed, expected);
}

#[test]
fn bundled_scene_skills_reference_only_files_they_ship() {
    let (_temp, root) = install();

    let mut missing = Vec::new();
    for (directory, _, _) in BUNDLED_SCENE_SKILLS {
        let skill_dir = root.as_path().join(directory);
        let contents = fs::read_to_string(skill_dir.join("SKILL.md")).expect("read SKILL.md");
        for reference in contents
            .split_whitespace()
            .filter_map(|token| {
                token
                    .trim_matches(['`', '(', ')', ',', '.', '—'])
                    .strip_prefix("references/")
            })
            .filter(|path| path.ends_with(".md"))
        {
            if !skill_dir.join("references").join(reference).is_file() {
                missing.push(format!("{directory}/references/{reference}"));
            }
        }
    }

    assert_eq!(missing, Vec::<String>::new());
}
