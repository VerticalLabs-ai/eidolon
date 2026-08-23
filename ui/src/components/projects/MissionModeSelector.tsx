/**
 * Accessible Mission mode selector with effective summary.
 *
 * Renders built-in modes (Auto, Fast, Deep Work, Analyst) in that fixed
 * order, followed by enabled company-defined custom profiles in their
 * deterministic server-provided order. Incompatible custom profiles remain
 * visible but disabled with a safe reason; disabled or foreign profiles are
 * absent from the list.
 *
 * Each choice exposes a visible name, description, and (when disabled) a
 * safe reason. The selector is a semantic radiogroup, fully keyboard
 * operable, with an effective mode summary region below.
 *
 * Built-in mode descriptions are code-owned constants from
 * `BUILT_IN_MODE_DISPLAY`. Custom profile name/description come from the
 * server-owned registry via `useModeProfiles`.
 */

import { useMemo } from 'react';
import { useModeProfiles } from '@/lib/hooks';
import { BUILT_IN_MODE_DISPLAY, type MissionMode, type MissionModeProfile } from '@/lib/api';

/** Cost ceilings per concrete mode (cents). Matches server BUILT_IN_MODES. */
const MODE_COST_CEILINGS: Record<MissionMode, number> = {
  auto: 10_000,
  fast: 500,
  deep_work: 5_000,
  analyst: 5_000,
};

/** Provisional Auto ceiling is the platform hard cap until classification. */
const PROVISIONAL_AUTO_CEILING = 10_000;

/** Deterministic Auto classifier over validated request metadata.
 * Mirrors the server-side classifier intent: explicit research/citation need
 * selects Analyst; complexity signals select Deep Work; otherwise Fast.
 * The authoritative resolution is server-side; this is a preview only. */
function resolvePreviewMode(mode: MissionMode, request: string): MissionMode {
  if (mode !== 'auto') {
    return mode;
  }
  const normalized = request.toLowerCase();
  if (/\b(research|sources?|citations?|web)\b/.test(normalized)) {
    return 'analyst';
  }
  if (/\b(and|then|compare|multiple|dependencies?)\b/.test(normalized)) {
    return 'deep_work';
  }
  return 'fast';
}

export interface MissionModeChoice {
  /** Stable choice ID: built-in mode value or `custom:<profileId>`. */
  choiceId: string;
  /** Display name. */
  name: string;
  /** Description shown to the user. */
  description: string;
  /** Whether the choice is selectable. */
  disabled: boolean;
  /** Safe reason when disabled, or null. */
  disabledReason: string | null;
  /** Built-in mode value when this is a built-in choice. */
  mode: MissionMode | null;
  /** Custom profile ID when this is a custom choice. */
  modeProfileId: string | null;
  isCustom: boolean;
}

/** Build the ordered list of mode choices from built-ins + custom profiles. */
export function buildModeChoices(profiles: MissionModeProfile[]): MissionModeChoice[] {
  const builtInChoices: MissionModeChoice[] = BUILT_IN_MODE_DISPLAY.map((display) => ({
    choiceId: display.id,
    name: display.name,
    description: display.description,
    disabled: false,
    disabledReason: null,
    mode: display.id,
    modeProfileId: null,
    isCustom: false,
  }));

  const customChoices: MissionModeChoice[] = profiles
    .filter((p) => p.enabled)
    .sort((a, b) => a.order - b.order)
    .map((p) => ({
      choiceId: `custom:${p.id}`,
      name: p.name,
      description: p.description,
      disabled: !!p.incompatibilityReason,
      disabledReason: p.incompatibilityReason ?? null,
      mode: null,
      modeProfileId: p.id,
      isCustom: true,
    }));

  return [...builtInChoices, ...customChoices];
}

export interface MissionModeSelectorProps {
  companyId: string;
  /** Currently selected built-in mode. */
  selectedMode: MissionMode;
  /** Currently selected custom profile ID, or null when a built-in is selected. */
  selectedModeProfileId: string | null;
  /** Called when the user selects a mode choice. */
  onSelect: (mode: MissionMode, modeProfileId: string | null) => void;
  /** Current request text (for Auto preview classification). */
  requestText: string;
}

export function MissionModeSelector({
  companyId,
  selectedMode,
  selectedModeProfileId,
  onSelect,
  requestText,
}: MissionModeSelectorProps) {
  const profilesQuery = useModeProfiles(companyId);
  const profiles = profilesQuery.data?.profiles ?? [];

  const choices = useMemo(() => buildModeChoices(profiles), [profiles]);

  const selectedChoiceId = selectedModeProfileId ? `custom:${selectedModeProfileId}` : selectedMode;

  const selectedChoice = choices.find((c) => c.choiceId === selectedChoiceId);

  // Effective summary computation.
  const trimmedRequest = requestText.trim();
  const isAutoProvisional = selectedMode === 'auto' && !selectedModeProfileId && !trimmedRequest;
  const resolvedMode = resolvePreviewMode(selectedMode, trimmedRequest);
  const ceiling = isAutoProvisional
    ? PROVISIONAL_AUTO_CEILING
    : selectedChoice?.isCustom
      ? MODE_COST_CEILINGS.auto // Custom profiles inherit the platform cap; server narrows.
      : MODE_COST_CEILINGS[resolvedMode];

  const effectiveModeName = selectedChoice?.isCustom
    ? selectedChoice.name
    : isAutoProvisional
      ? 'Auto (provisional)'
      : (BUILT_IN_MODE_DISPLAY.find((d) => d.id === resolvedMode)?.name ?? 'Auto');

  const effectiveDescription = selectedChoice?.isCustom
    ? selectedChoice.description
    : isAutoProvisional
      ? BUILT_IN_MODE_DISPLAY.find((d) => d.id === 'auto')!.description
      : (BUILT_IN_MODE_DISPLAY.find((d) => d.id === resolvedMode)?.description ?? '');

  return (
    <div>
      <fieldset className="mb-3" role="radiogroup" aria-label="Mission mode">
        <legend className="block text-xs font-medium text-text-secondary mb-1.5">
          Mission mode
        </legend>
        <div className="space-y-1.5">
          {choices.map((choice) => {
            const descriptionId = `mode-desc-${choice.choiceId}`;
            const reasonId = `mode-reason-${choice.choiceId}`;
            const isSelected = choice.choiceId === selectedChoiceId;
            return (
              <div
                key={choice.choiceId}
                className={`rounded-md border px-3 py-2 transition-colors ${
                  isSelected
                    ? 'border-accent/40 bg-accent/[0.06]'
                    : 'border-white/[0.06] bg-white/[0.015]'
                } ${choice.disabled ? 'opacity-60' : ''}`}
              >
                <label
                  className={`flex items-start gap-2 ${
                    choice.disabled ? 'cursor-not-allowed' : 'cursor-pointer'
                  }`}
                >
                  <input
                    type="radio"
                    name="mission-mode"
                    value={choice.choiceId}
                    checked={isSelected}
                    onChange={() => {
                      if (choice.disabled) {return;}
                      onSelect(choice.mode ?? 'auto', choice.modeProfileId);
                    }}
                    disabled={choice.disabled}
                    aria-checked={isSelected}
                    aria-describedby={
                      choice.disabled ? `${descriptionId} ${reasonId}` : descriptionId
                    }
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                  />
                  <span className="text-sm font-medium text-text-primary">{choice.name}</span>
                </label>
                <p
                  id={descriptionId}
                  className="mt-1 pl-5.5 text-xs leading-relaxed text-text-muted"
                >
                  {choice.description}
                </p>
                {choice.disabled && choice.disabledReason && (
                  <p id={reasonId} className="mt-0.5 pl-5.5 text-xs text-text-muted italic">
                    {choice.disabledReason}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </fieldset>

      {/* Effective mode summary */}
      <div
        className="rounded-lg border border-white/[0.08] bg-white/[0.025] px-3 py-2.5"
        aria-label="Effective mode summary"
      >
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-xs font-medium text-text-secondary">
            {isAutoProvisional ? 'Provisional hard ceiling' : 'Effective hard ceiling'}
          </p>
          <p className="text-sm font-semibold tabular-nums text-text-primary">
            {`$${(ceiling / 100).toFixed(2)}`}
          </p>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
          <span className="font-medium text-text-secondary">{effectiveModeName}: </span>
          {effectiveDescription}
        </p>
        {isAutoProvisional && (
          <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
            Auto will resolve to a concrete mode after you describe the request.
          </p>
        )}
      </div>
    </div>
  );
}
