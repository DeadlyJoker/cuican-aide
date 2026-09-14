import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ApplicationError,
  RunStoreError,
  type SkillLocator,
} from "@crewon/application";
import { SkillError, skillJson, type SkillVersionRef } from "@crewon/domain";
import {
  decodeSqliteDemonstratedSkillRow,
  decodeSqliteDemonstratedSkillVersionRow,
} from "./demonstrated-skill-store.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

/** Use inside the caller's SQLite transaction. This rechecks durable identity/state,
 * while application and per-action tool authorization remain separate requirements. */
export function requireSqliteSkillVersion(
  database: DatabaseSync,
  input: {
    locator: SkillLocator;
    ref: SkillVersionRef;
    purpose: "trial" | "schedule" | "execute";
  },
) {
  const { locator, ref } = input;
  if (locator.skillId !== ref.skillId)
    throw new RunStoreError("skill_ref_mismatch");
  const where =
    "tenant_id = ? AND space_id = ? AND owner_actor_id = ? AND skill_id = ?";
  const args = [
    locator.tenantId,
    locator.spaceId,
    locator.ownerActorId,
    locator.skillId,
  ];
  try {
    const row = database
      .prepare(
        `SELECT revision, record_json FROM demonstrated_skills WHERE ${where}`,
      )
      .get(...args) as { revision: number; record_json: string } | undefined;
    if (!row) throw new RunStoreError("skill_not_found");
    const skill = decodeSqliteDemonstratedSkillRow(row, locator, digester);
    if (skill.disabled !== false || skill.deleted !== false)
      throw new RunStoreError("skill_disabled");
    if (
      !Array.isArray(skill.activatedVersionIds) ||
      (input.purpose !== "trial" &&
        !skill.activatedVersionIds.includes(ref.versionId))
    )
      throw new RunStoreError("skill_not_active");
    const versionRow = database
      .prepare(
        `SELECT version_json, content_digest FROM demonstrated_skill_versions WHERE ${where} AND version_id = ?`,
      )
      .get(...args, ref.versionId) as
      | { version_json: string; content_digest: string }
      | undefined;
    if (!versionRow) throw new RunStoreError("skill_version_not_found");
    const version = decodeSqliteDemonstratedSkillVersionRow(
      versionRow,
      locator,
      ref.versionId,
      digester,
    );
    if (skillJson(version.ref) !== skillJson(ref))
      throw new RunStoreError("skill_ref_mismatch");
    return { skill, version };
  } catch (error) {
    if (error instanceof RunStoreError) throw error;
    if (error instanceof SkillError || error instanceof ApplicationError)
      throw new RunStoreError(error.code, { cause: error });
    throw new RunStoreError("skill_authority_unavailable", {
      cause: error instanceof Error ? error : undefined,
    });
  }
}
