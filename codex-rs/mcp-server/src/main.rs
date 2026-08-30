use crewon_arg0::Arg0DispatchPaths;
use crewon_arg0::arg0_dispatch_or_else;
use crewon_mcp_server::run_main;
use crewon_utils_options::ConfigOverrides;

fn main() -> anyhow::Result<()> {
    arg0_dispatch_or_else(|arg0_paths: Arg0DispatchPaths| async move {
        run_main(
            arg0_paths,
            ConfigOverrides::default(),
            /*strict_config*/ false,
        )
        .await?;
        Ok(())
    })
}
