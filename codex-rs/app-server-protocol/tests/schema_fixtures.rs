use anyhow::Context;
use anyhow::Result;
use crewon_app_server_protocol::generate_json_with_experimental;
use crewon_app_server_protocol::generate_platform_experimental_ts;
use crewon_app_server_protocol::generate_typescript_schema_fixture_subtree_for_tests;
use crewon_app_server_protocol::read_schema_fixture_subtree;
use similar::TextDiff;
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

#[test]
fn typescript_schema_fixtures_match_generated() -> Result<()> {
    let schema_root = schema_root()?;
    let fixture_tree = read_tree(&schema_root, "typescript")?;
    let generated_tree = generate_typescript_schema_fixture_subtree_for_tests()
        .context("generate in-memory typescript schema fixtures")?;

    assert_schema_trees_match("typescript", &fixture_tree, &generated_tree)?;

    Ok(())
}

#[test]
fn experimental_platform_typescript_schema_fixtures_match_generated() -> Result<()> {
    assert_schema_fixtures_match_generated("typescript-experimental-platform", |output_dir| {
        generate_platform_experimental_ts(output_dir, None)
    })
}

#[test]
fn experimental_platform_types_stay_out_of_the_stable_schema() -> Result<()> {
    let stable_tree = generate_typescript_schema_fixture_subtree_for_tests()
        .context("generate stable TypeScript schema fixtures")?;
    let overlay_tree = read_tree(&schema_root()?, "typescript-experimental-platform")?;

    for type_name in [
        "ProviderConnectParams",
        "ProviderConnectResponse",
        "ResourceBindParams",
        "ResourceBindResponse",
        "WorkspaceBindParams",
        "WorkspaceBindResponse",
    ] {
        let path = PathBuf::from("v2").join(format!("{type_name}.ts"));
        assert!(
            !stable_tree.contains_key(&path),
            "{type_name} leaked into stable schema"
        );
        assert!(
            overlay_tree.contains_key(&path),
            "{type_name} is missing from experimental platform overlay"
        );
    }

    Ok(())
}

#[test]
fn generated_typescript_relative_imports_resolve() -> Result<()> {
    let generated_tree = generate_typescript_schema_fixture_subtree_for_tests()
        .context("generate in-memory typescript schema fixtures")?;
    assert_typescript_relative_imports_resolve(&generated_tree)
}

#[test]
fn experimental_platform_typescript_relative_imports_resolve() -> Result<()> {
    let generated_tree = read_tree(&schema_root()?, "typescript-experimental-platform")?;
    assert_typescript_relative_imports_resolve(&generated_tree)
}

fn assert_typescript_relative_imports_resolve(
    generated_tree: &BTreeMap<PathBuf, Vec<u8>>,
) -> Result<()> {
    let mut missing_imports = Vec::new();

    for (path, contents) in generated_tree {
        if path.extension().and_then(|extension| extension.to_str()) != Some("ts") {
            continue;
        }
        let contents = std::str::from_utf8(contents)
            .with_context(|| format!("read generated TypeScript {}", path.display()))?;
        for line in contents.lines() {
            let Some(specifier) = relative_typescript_import_specifier(line) else {
                continue;
            };
            let imported_path = resolve_typescript_import(path, specifier);
            let imported_index_path = imported_path.with_extension("").join("index.ts");
            if !generated_tree.contains_key(&imported_path)
                && !generated_tree.contains_key(&imported_index_path)
            {
                missing_imports.push(format!(
                    "{} imports {specifier}, but {} was not generated",
                    path.display(),
                    imported_path.display()
                ));
            }
        }
    }

    assert!(
        missing_imports.is_empty(),
        "generated TypeScript contains unresolved relative imports:\n{}",
        missing_imports.join("\n")
    );
    Ok(())
}

#[test]
fn json_schema_fixtures_match_generated() -> Result<()> {
    assert_schema_fixtures_match_generated("json", |output_dir| {
        generate_json_with_experimental(output_dir, /*experimental_api*/ false)
    })
}

fn assert_schema_fixtures_match_generated(
    label: &'static str,
    generate: impl FnOnce(&Path) -> Result<()>,
) -> Result<()> {
    let schema_root = schema_root()?;
    let fixture_tree = read_tree(&schema_root, label)?;

    let temp_dir = tempfile::tempdir().context("create temp dir")?;
    let generated_root = temp_dir.path().join(label);
    generate(&generated_root).with_context(|| {
        format!(
            "generate {label} schema fixtures into {}",
            generated_root.display()
        )
    })?;

    let generated_tree = read_tree(temp_dir.path(), label)?;

    assert_schema_trees_match(label, &fixture_tree, &generated_tree)?;

    Ok(())
}

fn assert_schema_trees_match(
    label: &str,
    fixture_tree: &BTreeMap<PathBuf, Vec<u8>>,
    generated_tree: &BTreeMap<PathBuf, Vec<u8>>,
) -> Result<()> {
    let fixture_paths = fixture_tree
        .keys()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>();
    let generated_paths = generated_tree
        .keys()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>();

    if fixture_paths != generated_paths {
        let expected = fixture_paths.join("\n");
        let actual = generated_paths.join("\n");
        let diff = TextDiff::from_lines(&expected, &actual)
            .unified_diff()
            .header("fixture", "generated")
            .to_string();

        panic!(
            "Vendored {label} app-server schema fixture file set doesn't match freshly generated output. \
Run `just write-app-server-schema` to overwrite with your changes.\n\n{diff}"
        );
    }

    // If the file sets match, diff contents for each file for a nicer error.
    for (path, expected) in fixture_tree {
        let actual = generated_tree
            .get(path)
            .ok_or_else(|| anyhow::anyhow!("missing generated file: {}", path.display()))?;

        if expected == actual {
            continue;
        }

        let expected_str = String::from_utf8_lossy(expected);
        let actual_str = String::from_utf8_lossy(actual);
        let diff = TextDiff::from_lines(&expected_str, &actual_str)
            .unified_diff()
            .header("fixture", "generated")
            .to_string();
        panic!(
            "Vendored {label} app-server schema fixture {} differs from generated output. \
Run `just write-app-server-schema` to overwrite with your changes.\n\n{diff}",
            path.display()
        );
    }

    Ok(())
}

fn schema_root() -> Result<PathBuf> {
    // In Bazel runfiles (especially manifest-only mode), resolving directories is not
    // reliable. Resolve a known file, then walk up to the schema root.
    let typescript_index = crewon_utils_cargo_bin::find_resource!("schema/typescript/index.ts")
        .context("resolve TypeScript schema index.ts")?;
    let schema_root = typescript_index
        .parent()
        .and_then(|p| p.parent())
        .context("derive schema root from schema/typescript/index.ts")?
        .to_path_buf();

    // Sanity check that the JSON fixtures resolve to the same schema root.
    let json_bundle = crewon_utils_cargo_bin::find_resource!(
        "schema/json/crewon_app_server_protocol.schemas.json"
    )
    .context("resolve JSON schema bundle")?;
    let json_root = json_bundle
        .parent()
        .and_then(|p| p.parent())
        .context("derive schema root from schema/json/crewon_app_server_protocol.schemas.json")?;
    anyhow::ensure!(
        schema_root == json_root,
        "schema roots disagree: typescript={} json={}",
        schema_root.display(),
        json_root.display()
    );

    Ok(schema_root)
}

fn read_tree(root: &Path, label: &str) -> Result<BTreeMap<PathBuf, Vec<u8>>> {
    read_schema_fixture_subtree(root, label).with_context(|| {
        format!(
            "read {label} schema fixture subtree from {}",
            root.display()
        )
    })
}

fn relative_typescript_import_specifier(line: &str) -> Option<&str> {
    let line = line.trim();
    let marker = " from \"";
    let start = line.find(marker)? + marker.len();
    let rest = &line[start..];
    let end = rest.find('"')?;
    let specifier = &rest[..end];
    specifier.starts_with('.').then_some(specifier)
}

fn resolve_typescript_import(importer: &Path, specifier: &str) -> PathBuf {
    let mut resolved = importer
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .to_path_buf();
    for component in specifier.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                resolved.pop();
            }
            name => resolved.push(name),
        }
    }
    resolved.set_extension("ts");
    resolved
}
