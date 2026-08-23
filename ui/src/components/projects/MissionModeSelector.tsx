/**
 * Accessible Mission mode selector with effective summary.
 *
 * Renders built-in modes (Auto, Fast, Deep Work, Analyst) in that fixed
 * order, followed by enabled company-defined custom profiles in normalized
 * display-name order with stable profile-ID tie-break. Incompatible custom
 * profiles remain visible but disabled with a safe reason; disabled or
 * foreign profiles are absent from the list. Duplicate profile IDs are
 * deduplicated so a repeated server response never produces two choices
 * for the same profile (VAL-MODEQ-125).
 *
 * When the mode-registry query fails, the selector renders an accessible
 * error and Retry button instead of the mode list. Mission start is
 * unavailable while the registry is unavailable, and no stale foreign
 * profile is selectable (VAL-MODEQ-122).
 *
 * Each choice exposes a visible name, description, and (when disabled) a
 * safe reason. When two profiles share the same display name, each
 * radio's accessible name is disambiguated with the profile slug so
 * assistive technology can distinguish them (VAL-MODEQ-125).
 *
 * Built-in mode descriptions are code-owned constants from
 * `BUILT_IN_MODE_DISPLAY`. Custom profile name/description come from the
 * server-owned registry.
 */

import { useMemo } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { BUILT_IN_MODE_DISPLAY, type MissionMode, type MissionModeProfile } from '@/lib/api';
import { Button } from '@/components/ui/Button';

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

/** Normalize a display name for deterministic ordering: Unicode NFC +
 * lowercase + trim. This mirrors the server's normalized-name ordering
 * (VAL-MODEQ-125, VAL-MODEQ-153). */
function normalizeName(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
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
  /** Accessible name for the radio, disambiguated when display names
   * collide (VAL-MODEQ-125). */
  accessibleName: string;
}

/** Build the ordered list of mode choices from built-ins + custom profiles.
 *
 * Custom profiles are sorted by normalized display name with a stable
 * profile-ID tie-break, deduplicated by profile ID, and given
 * disambiguated accessible names when display names collide. */
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
    accessibleName: display.name,
  }));

  // Filter enabled profiles, deduplicate by profile ID, and sort by
  // normalized display name with stable profile-ID tie-break
  // (VAL-MODEQ-125).
  const seenIds = new Set<string>();
  const enabledProfiles = profiles
    .filter((p) => p.enabled)
    .filter((p) => {
      if (seenIds.has(p.id)) {
        return false; // deduplicate
      }
      seenIds.add(p.id);
      return true;
    })
    .sort((a, b) => {
      const nameA = normalizeName(a.name);
      const nameB = normalizeName(b.name);
      if (nameA < nameB) {
        return -1;
      }
      if (nameA > nameB) {
        return 1;
      }
      // Stable tie-break by profile ID
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  // Detect display-name collisions to disambiguate accessible names
  const nameCounts = new Map<string, number>();
  for (const p of enabledProfiles) {
    const normalized = normalizeName(p.name);
    nameCounts.set(normalized, (nameCounts.get(normalized) ?? 0) + 1);
  }

  const customChoices: MissionModeChoice[] = enabledProfiles.map((p) => {
    const hasCollision = (nameCounts.get(normalizeName(p.name)) ?? 0) > 1;
    return {
      choiceId: `custom:${p.id}`,
      name: p.name,
      description: p.description,
      disabled: !!p.incompatibilityReason,
      disabledReason: p.incompatibilityReason ?? null,
      mode: null,
      modeProfileId: p.id,
      isCustom: true,
      // When display names collide, append the slug to the accessible name
      // so assistive technology can distinguish the two choices
      // (VAL-MODEQ-125).
      accessibleName: hasCollision ? `${p.name} (${p.slug})` : p.name,
    };
  });

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
  /** Custom profiles from the server registry. When undefined, only
   * built-ins are shown. */
  profiles: MissionModeProfile[];
  /** Whether the registry query is loading. */
  profilesLoading: boolean;
  /** Whether the registry query failed. When true, the selector renders an
   * accessible error and Retry button instead of the mode list
   * (VAL-MODEQ-122). */
  profilesError: boolean;
  /** Retry handler called when the user activates Retry. */
  onRetry: () => void;
}

export function MissionModeSelector({
  selectedMode,
  selectedModeProfileId,
  onSelect,
  requestText,
  profiles,
  profilesLoading,
  profilesError,
  onRetry,
}: MissionModeSelectorProps) {
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

  // Fail-closed registry error: show an accessible error and Retry instead
  // of the mode list. No stale foreign profile is selectable. Mission start
  // is disabled by the parent form while this error is visible
  // (VAL-MODEQ-122).
  if (profilesError) {
    return (
      <div>
        <fieldset className="mb-3" role="radiogroup" aria-label="Mission mode">
          <legend className="block text-xs font-medium text-text-secondary mb-1.5">
            Mission mode
          </legend>
          <div
            className="rounded-md border border-error/30 bg-error/[0.04] px-3 py-2.5"
            role="alert"
          >
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-error" aria-hidden="true" />
              <div className="space-y-1.5">
                <p className="text-sm text-text-primary">
                  Mission modes could not be loaded. Start is unavailable until they load.
                </p>
                <p className="text-xs text-text-muted">
                  Your request draft is preserved. Retry to load the current company&apos;s modes.
                </p>
                <Button
                  type="button"
                  onClick={onRetry}
                  disabled={profilesLoading}
                  loading={profilesLoading}
                  icon={<RefreshCw className="h-3.5 w-3.5" />}
                  aria-label="Retry loading mission modes"
                >
                  Retry
                </Button>
              </div>
            </div>
          </div>
        </fieldset>
      </div>
    );
  }

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
                      if (choice.disabled) {
                        return;
                      }
                      onSelect(choice.mode ?? 'auto', choice.modeProfileId);
                    }}
                    disabled={choice.disabled}
                    aria-checked={isSelected}
                    aria-label={choice.accessibleName}
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
