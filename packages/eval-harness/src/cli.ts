import { readFileSync } from "node:fs";

import {
  compareTeamEffectVariants,
  evaluateTeamEffectQuality,
  parseTeamEffectCase,
  parseTeamEffectGuiTrace,
} from "./team-effect-evaluation.ts";

export const TEAM_EFFECT_CLI_ERROR_SCHEMA_VERSION =
  "crewon.team-effect-cli-error.v1" as const;

const USAGE = [
  "Usage:",
  "  pnpm --silent --filter @crewon/eval-harness evaluate -- <case.json> <trace.json>",
  "  pnpm --silent --filter @crewon/eval-harness compare -- <case.json> <baseline.json> <candidate.json>",
].join("\n");

export type TeamEffectCliIo = Readonly<{
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}>;

/** Reads local JSON artifacts only. It never starts CrewON or uses a network API. */
export function runTeamEffectCli(
  args: readonly string[],
  io: TeamEffectCliIo = processIo,
): number {
  const [command, ...rawPaths] = args;
  const paths = rawPaths[0] === "--" ? rawPaths.slice(1) : rawPaths;
  if (
    (command !== "evaluate" && command !== "compare") ||
    (command === "evaluate" && paths.length !== 2) ||
    (command === "compare" && paths.length !== 3)
  ) {
    io.writeStderr(`${USAGE}\n`);
    return 2;
  }

  try {
    const testCase = parseTeamEffectCase(readJsonFile(paths[0]!));
    if (command === "evaluate") {
      const trace = parseTeamEffectGuiTrace(readJsonFile(paths[1]!));
      const result = evaluateTeamEffectQuality(testCase, trace);
      writeJson(io.writeStdout, result);
      return result.passed ? 0 : 1;
    }

    const baseline = parseTeamEffectGuiTrace(readJsonFile(paths[1]!));
    const candidate = parseTeamEffectGuiTrace(readJsonFile(paths[2]!));
    const result = compareTeamEffectVariants(testCase, baseline, candidate);
    writeJson(io.writeStdout, result);
    return result.status === "compared" &&
      result.efficiencyFailures.length === 0
      ? 0
      : 1;
  } catch (error) {
    const normalized = normalizeCliError(error);
    writeJson(io.writeStderr, {
      schemaVersion: TEAM_EFFECT_CLI_ERROR_SCHEMA_VERSION,
      passed: false,
      error: normalized,
    });
    return 2;
  }
}

function readJsonFile(path: string): unknown {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    throw new TeamEffectCliError(
      "team_effect_cli_file_read_failed",
      `Could not read local fixture ${JSON.stringify(path)}.`,
    );
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new TeamEffectCliError(
      "team_effect_cli_json_invalid",
      `Fixture ${JSON.stringify(path)} is not valid JSON.`,
    );
  }
}

function normalizeCliError(error: unknown): Readonly<{
  code: string;
  detail: string;
}> {
  if (error instanceof TeamEffectCliError) {
    return { code: error.code, detail: error.message };
  }
  if (
    error instanceof TypeError &&
    /^team_effect_[a-z0-9_]+$/u.test(error.message)
  ) {
    return {
      code: error.message,
      detail: `The fixture violated ${error.message}; update the artifact to the documented v1 shape.`,
    };
  }
  return {
    code: "team_effect_cli_evaluation_failed",
    detail:
      error instanceof Error ? error.message : "Unknown evaluation error.",
  };
}

function writeJson(write: (value: string) => void, value: unknown): void {
  write(`${JSON.stringify(value, null, 2)}\n`);
}

class TeamEffectCliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const processIo: TeamEffectCliIo = {
  writeStdout: (value) => process.stdout.write(value),
  writeStderr: (value) => process.stderr.write(value),
};

if (import.meta.main) {
  process.exitCode = runTeamEffectCli(process.argv.slice(2));
}
