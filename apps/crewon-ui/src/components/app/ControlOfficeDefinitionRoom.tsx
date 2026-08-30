import type {
  CreateOfficeRequest,
  OfficeContract,
  OfficeExecutionTargetContract,
  OfficeMemberContract,
} from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";
import {
  ArrowLeft,
  Check,
  RotateCcw,
  Trash2,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { Locale } from "../../lib/i18n";
import { controlOfficeRecord } from "../../lib/office/controlOfficeRuntime";
import {
  officeMemberAgentProfileHasChanges,
  officeMemberAgentProfileId,
  type OfficeMemberAgentProfile,
} from "../../lib/office/officeMemberAgentProfile";
import {
  officeMemberDisplayName,
  type ControlOfficeDefinitionRecordReference,
} from "../../lib/office/officePanelFromRecord";
import { ControlOfficeMemberAgentSettings } from "./ControlOfficeMemberAgentSettings";

type OfficeSettingsClient = Pick<
  ControlApiClient,
  "createOffice" | "getOffice"
>;

export type ControlOfficeMemberAgentSettingsBridge = Readonly<{
  load(input: {
    agentId: string;
    agentVersionId: string;
    displayName: string;
  }): Promise<OfficeMemberAgentProfile>;
  save(config: OfficeMemberAgentProfile): Promise<void>;
}>;

export type OfficeMemberDraft = Readonly<{
  member: OfficeMemberContract;
  target: OfficeExecutionTargetContract;
}>;

function memberDraftsFromOffice(office: {
  members: ReadonlyArray<OfficeMemberContract>;
  executionTargets: ReadonlyArray<OfficeExecutionTargetContract>;
}): OfficeMemberDraft[] {
  return office.members.flatMap((member, index) => {
    const target = office.executionTargets[index];
    return target && target.agentVersionId === member.agentVersionId
      ? [{ member: { ...member }, target: { ...target } }]
      : [];
  });
}

export function officeMemberDraftsHaveChanges(
  office: OfficeContract,
  drafts: readonly OfficeMemberDraft[],
) {
  return (
    drafts.length !== office.members.length ||
    drafts.some(
      (draft, index) =>
        draft.member.memberId !== office.members[index]?.memberId ||
        draft.member.displayName !== office.members[index]?.displayName,
    )
  );
}

export function officeMembersWithLead(
  drafts: readonly OfficeMemberDraft[],
  memberId: string,
) {
  const selected = drafts.find((draft) => draft.member.memberId === memberId);
  return selected
    ? [
        selected,
        ...drafts.filter((draft) => draft.member.memberId !== memberId),
      ]
    : [...drafts];
}

export function controlOfficeSettingsRequest(
  office: OfficeContract,
  drafts: readonly OfficeMemberDraft[],
): CreateOfficeRequest {
  return {
    officeId: office.officeId,
    expectedRevision: office.revision,
    title: office.title,
    members: drafts.map((draft) => ({
      ...draft.member,
      displayName: draft.member.displayName.trim(),
    })),
    executionTargets: drafts.map((draft) => ({ ...draft.target })),
  };
}

function fallbackMemberDrafts(
  record: ControlOfficeDefinitionRecordReference,
): OfficeMemberDraft[] {
  return memberDraftsFromOffice(record.definition);
}

function officeSettingsError(locale: Locale) {
  return locale === "zh"
    ? "设置没有保存，请稍后再试。"
    : "The settings were not saved. Please try again.";
}

export function ControlOfficeDefinitionRoom({
  agentSettings,
  client,
  locale,
  onBack,
  onSaved,
  record,
}: {
  agentSettings?: ControlOfficeMemberAgentSettingsBridge;
  client: OfficeSettingsClient;
  locale: Locale;
  onBack: () => void;
  onSaved: (record: ControlOfficeDefinitionRecordReference) => void;
  record: ControlOfficeDefinitionRecordReference;
}) {
  const zh = locale === "zh";
  const [office, setOffice] = useState<OfficeContract | null>(null);
  const [drafts, setDrafts] = useState<OfficeMemberDraft[]>(() =>
    fallbackMemberDrafts(record),
  );
  const [selectedMemberId, setSelectedMemberId] = useState(
    () => record.definition.members[0]?.memberId ?? null,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [profiles, setProfiles] = useState<
    Record<string, OfficeMemberAgentProfile>
  >({});
  const [savedProfiles, setSavedProfiles] = useState<
    Record<string, OfficeMemberAgentProfile>
  >({});
  const [profileLoadingId, setProfileLoadingId] = useState<string | null>(null);
  const [profileErrorByMember, setProfileErrorByMember] = useState<
    Record<string, string>
  >({});

  const loadOffice = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await client.getOffice(
        record.definition.officeVersionId,
      );
      const nextDrafts = memberDraftsFromOffice(response.office);
      setOffice(response.office);
      setDrafts(nextDrafts);
      setProfiles({});
      setSavedProfiles({});
      setProfileErrorByMember({});
      setSelectedMemberId((current) =>
        nextDrafts.some((draft) => draft.member.memberId === current)
          ? current
          : (nextDrafts[0]?.member.memberId ?? null),
      );
    } catch {
      setError(
        zh
          ? "暂时无法读取最新设置，请重试。"
          : "The latest settings could not be loaded. Try again.",
      );
    } finally {
      setLoading(false);
    }
  }, [client, record.definition.officeVersionId, zh]);

  useEffect(() => {
    void loadOffice();
  }, [loadOffice]);

  const selectedIndex = drafts.findIndex(
    (draft) => draft.member.memberId === selectedMemberId,
  );
  const selectedDraft = selectedIndex >= 0 ? drafts[selectedIndex] : null;
  const officeDirty = office
    ? officeMemberDraftsHaveChanges(office, drafts)
    : false;
  const activeMemberIds = new Set(drafts.map((draft) => draft.member.memberId));
  const dirtyProfileIds = Object.keys(profiles).filter((memberId) => {
    const profile = profiles[memberId];
    const baseline = savedProfiles[memberId];
    return Boolean(
      activeMemberIds.has(memberId) &&
        profile &&
        baseline &&
        officeMemberAgentProfileHasChanges(profile, baseline),
    );
  });
  const profileDirty = dirtyProfileIds.length > 0;
  const dirty = officeDirty || profileDirty;
  const selectedProfile = selectedMemberId
    ? (profiles[selectedMemberId] ?? null)
    : null;
  const selectedProfileError = selectedMemberId
    ? (profileErrorByMember[selectedMemberId] ?? null)
    : null;
  const namesValid = drafts.every(
    (draft) => draft.member.displayName.trim().length > 0,
  );
  const canSave = Boolean(
    office &&
      dirty &&
      namesValid &&
      !loading &&
      !saving &&
      !profileLoadingId &&
      drafts.length > 0 &&
      (!profileDirty || agentSettings),
  );
  const statusText = useMemo(() => {
    if (saving) return zh ? "正在保存" : "Saving";
    if (loading) return zh ? "正在读取" : "Loading";
    if (error) return zh ? "需要重试" : "Retry needed";
    if (saved && !dirty) return zh ? "已保存" : "Saved";
    if (dirty) return zh ? "有未保存更改" : "Unsaved changes";
    return zh ? "已是最新" : "Up to date";
  }, [dirty, error, loading, saved, saving, zh]);
  const showStatus = loading || saving || Boolean(error) || dirty || saved;

  const loadSelectedProfile = useCallback(async () => {
    if (!agentSettings || !office || !selectedDraft) {
      if (selectedDraft) {
        setProfileErrorByMember((current) => ({
          ...current,
          [selectedDraft.member.memberId]: zh
            ? "成员配置服务尚未连接。"
            : "Member settings are not connected.",
        }));
      }
      return;
    }
    const memberId = selectedDraft.member.memberId;
    setProfileLoadingId(memberId);
    setProfileErrorByMember((current) => {
      const next = { ...current };
      delete next[memberId];
      return next;
    });
    try {
      const profile = await agentSettings.load({
        agentId: officeMemberAgentProfileId(office.officeVersionId, memberId),
        agentVersionId: selectedDraft.member.agentVersionId,
        displayName: selectedDraft.member.displayName,
      });
      setProfiles((current) => ({ ...current, [memberId]: profile }));
      setSavedProfiles((current) => ({ ...current, [memberId]: profile }));
    } catch (reason) {
      setProfileErrorByMember((current) => ({
        ...current,
        [memberId]:
          reason instanceof Error
            ? reason.message
            : zh
              ? "成员配置没有读取成功。"
              : "The member settings could not be loaded.",
      }));
    } finally {
      setProfileLoadingId((current) => (current === memberId ? null : current));
    }
  }, [agentSettings, office, selectedDraft, zh]);

  useEffect(() => {
    if (
      selectedMemberId &&
      !profiles[selectedMemberId] &&
      profileLoadingId !== selectedMemberId &&
      !profileErrorByMember[selectedMemberId]
    ) {
      void loadSelectedProfile();
    }
  }, [
    loadSelectedProfile,
    profileErrorByMember,
    profileLoadingId,
    profiles,
    selectedMemberId,
  ]);

  function resetDrafts() {
    if (!office) return;
    const nextDrafts = memberDraftsFromOffice(office);
    setDrafts(nextDrafts);
    setProfiles(savedProfiles);
    setSelectedMemberId((current) =>
      nextDrafts.some((draft) => draft.member.memberId === current)
        ? current
        : (nextDrafts[0]?.member.memberId ?? null),
    );
    setError(null);
    setSaved(false);
  }

  function updateSelectedName(displayName: string) {
    if (!selectedMemberId) return;
    setDrafts((current) =>
      current.map((draft) =>
        draft.member.memberId === selectedMemberId
          ? { ...draft, member: { ...draft.member, displayName } }
          : draft,
      ),
    );
    setProfiles((current) =>
      selectedMemberId && current[selectedMemberId]
        ? {
            ...current,
            [selectedMemberId]: {
              ...current[selectedMemberId],
              name: displayName,
            },
          }
        : current,
    );
    setSaved(false);
  }

  function updateSelectedProfile(profile: OfficeMemberAgentProfile) {
    if (!selectedMemberId) return;
    setProfiles((current) => ({ ...current, [selectedMemberId]: profile }));
    setSaved(false);
  }

  function makeSelectedLead() {
    if (!selectedMemberId) return;
    setDrafts((current) => officeMembersWithLead(current, selectedMemberId));
    setSaved(false);
  }

  function removeSelectedMember() {
    if (!selectedMemberId || drafts.length <= 1) return;
    const nextDrafts = drafts.filter(
      (draft) => draft.member.memberId !== selectedMemberId,
    );
    const nextSelection =
      nextDrafts[Math.min(selectedIndex, nextDrafts.length - 1)] ??
      nextDrafts[0];
    setDrafts(nextDrafts);
    setSelectedMemberId(nextSelection?.member.memberId ?? null);
    setSaved(false);
  }

  async function saveSettings() {
    if (!office || !canSave) return;
    setSaving(true);
    setError(null);
    try {
      if (profileDirty && agentSettings) {
        await Promise.all(
          dirtyProfileIds.flatMap((memberId) => {
            const profile = profiles[memberId];
            return profile ? [agentSettings.save(profile)] : [];
          }),
        );
        setSavedProfiles((current) => {
          const next = { ...current };
          for (const memberId of dirtyProfileIds) {
            const profile = profiles[memberId];
            if (profile) next[memberId] = profile;
          }
          return next;
        });
      }
      if (officeDirty) {
        const response = await client.createOffice(
          controlOfficeSettingsRequest(office, drafts),
          `office.settings.update:${crypto.randomUUID()}`,
        );
        const nextDrafts = memberDraftsFromOffice(response.office);
        setOffice(response.office);
        setDrafts(nextDrafts);
        onSaved(controlOfficeRecord(response.office));
      }
      setSaved(true);
    } catch {
      setError(officeSettingsError(locale));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="control-office-definition-room"
      data-control-office-definition=""
    >
      <header className="control-office-definition-header">
        <button className="button compact" type="button" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          {zh ? "返回" : "Back"}
        </button>
        <div className="control-office-definition-title">
          <span>{zh ? "成员设置" : "Member settings"}</span>
          <h2 title={record.config.title}>{record.config.title}</h2>
          <p>
            {drafts.length} {zh ? "名成员" : "members"}
          </p>
        </div>
        <div className="control-office-definition-actions">
          {showStatus ? (
            <span
              className="control-office-save-status"
              data-state={error ? "error" : dirty ? "dirty" : "ready"}
              role="status"
            >
              {saved && !dirty ? <Check aria-hidden="true" /> : null}
              {statusText}
            </span>
          ) : null}
          {dirty ? (
            <button
              className="button compact"
              disabled={saving}
              type="button"
              onClick={resetDrafts}
            >
              <RotateCcw aria-hidden="true" />
              {zh ? "撤销" : "Reset"}
            </button>
          ) : null}
          <button
            className="button primary compact"
            disabled={!canSave}
            type="button"
            onClick={() => void saveSettings()}
          >
            {saving ? (zh ? "保存中" : "Saving") : zh ? "保存" : "Save"}
          </button>
        </div>
      </header>

      <main className="control-office-definition-body">
        {error ? (
          <div className="control-office-settings-alert" role="alert">
            <span>{error}</span>
            {!office ? (
              <button type="button" onClick={() => void loadOffice()}>
                {zh ? "重试" : "Try again"}
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="control-office-settings-layout">
          <section className="control-office-definition-members">
            <header>
              <h3>{zh ? "办公室成员" : "Office members"}</h3>
              <em>{drafts.length}</em>
            </header>
            <div
              aria-label={zh ? "办公室成员" : "Office members"}
              className="control-office-member-list"
            >
              {drafts.map((draft, index) => {
                const displayName = officeMemberDisplayName(
                  draft.member.displayName,
                  index,
                  locale,
                );
                const selected = draft.member.memberId === selectedMemberId;
                return (
                  <button
                    aria-current={selected ? "true" : undefined}
                    className="control-office-member-row"
                    key={draft.member.memberId}
                    type="button"
                    onClick={() => setSelectedMemberId(draft.member.memberId)}
                  >
                    <span
                      className="control-office-member-avatar"
                      aria-hidden="true"
                    >
                      {Array.from(displayName)[0] || "员"}
                    </span>
                    <span className="control-office-member-copy">
                      <span className="control-office-member-name-line">
                        <strong title={displayName}>{displayName}</strong>
                        {index === 0 ? <em>{zh ? "组长" : "Lead"}</em> : null}
                      </span>
                      <small>
                        {index === 0
                          ? zh
                            ? "负责协调和回复"
                            : "Coordinates and replies"
                          : zh
                            ? "参与任务协作"
                            : "Works on assigned tasks"}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section
            className="control-office-member-settings"
            aria-label={zh ? "成员详情" : "Member details"}
          >
            {selectedDraft ? (
              <>
                <header>
                  <span
                    className="control-office-member-avatar control-office-member-avatar-large"
                    aria-hidden="true"
                  >
                    {Array.from(
                      officeMemberDisplayName(
                        selectedDraft.member.displayName,
                        Math.max(selectedIndex, 0),
                        locale,
                      ),
                    )[0] || "员"}
                  </span>
                  <h3>
                    {officeMemberDisplayName(
                      selectedDraft.member.displayName,
                      Math.max(selectedIndex, 0),
                      locale,
                    )}
                  </h3>
                  <em>
                    {selectedIndex === 0
                      ? zh
                        ? "组长"
                        : "Lead"
                      : zh
                        ? "成员"
                        : "Member"}
                  </em>
                </header>

                <div className="control-office-member-form">
                  <label htmlFor="control-office-member-name">
                    <span>{zh ? "成员名称" : "Member name"}</span>
                    <input
                      aria-invalid={!selectedDraft.member.displayName.trim()}
                      id="control-office-member-name"
                      maxLength={160}
                      type="text"
                      value={selectedDraft.member.displayName}
                      onChange={(event) =>
                        updateSelectedName(event.currentTarget.value)
                      }
                    />
                    <small>
                      {zh
                        ? "群聊和任务中会显示这个名称"
                        : "This name appears in chat and tasks"}
                    </small>
                  </label>

                  <div className="control-office-role-setting">
                    <div>
                      <strong>
                        {selectedIndex === 0
                          ? zh
                            ? "办公室组长"
                            : "Office lead"
                          : zh
                            ? "协作成员"
                            : "Collaborator"}
                      </strong>
                      <p>
                        {selectedIndex === 0
                          ? zh
                            ? "负责分工、跟进进展并统一回复你"
                            : "Assigns work, follows progress, and replies to you"
                          : zh
                            ? "接收组长分配的任务并反馈结果"
                            : "Takes assigned work and reports results"}
                      </p>
                    </div>
                    {selectedIndex > 0 ? (
                      <button type="button" onClick={makeSelectedLead}>
                        {zh ? "设为组长" : "Make lead"}
                      </button>
                    ) : null}
                  </div>

                  <ControlOfficeMemberAgentSettings
                    error={selectedProfileError}
                    loading={Boolean(
                      agentSettings &&
                        !selectedProfile &&
                        !selectedProfileError,
                    )}
                    locale={locale}
                    profile={selectedProfile}
                    onChange={updateSelectedProfile}
                    onRetry={() => void loadSelectedProfile()}
                  />

                  <div className="control-office-member-remove">
                    <div>
                      <strong>
                        {zh ? "移出办公室" : "Remove from Office"}
                      </strong>
                      <p>
                        {drafts.length <= 1
                          ? zh
                            ? "办公室至少保留一名成员"
                            : "An Office needs at least one member"
                          : zh
                            ? "保存后，该成员将不再参与新的任务"
                            : "After saving, this member will leave new tasks"}
                      </p>
                    </div>
                    <button
                      aria-label={zh ? "移出办公室" : "Remove from Office"}
                      disabled={drafts.length <= 1}
                      type="button"
                      onClick={removeSelectedMember}
                    >
                      <Trash2 aria-hidden="true" />
                      {zh ? "移出" : "Remove"}
                    </button>
                  </div>
                </div>

              </>
            ) : (
              <div className="control-office-member-settings-empty">
                <Users aria-hidden="true" />
                <strong>
                  {zh ? "还没有可设置的成员" : "No members to edit"}
                </strong>
              </div>
            )}
          </section>
        </div>
      </main>
    </section>
  );
}
