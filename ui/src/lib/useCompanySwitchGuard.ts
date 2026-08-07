import { useState, useRef, useEffect, useCallback, createContext, useContext } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { getDirtyEditorGuard } from "./dirty-editor";

/**
 * Context providing the effective companyId (which may lag behind the URL
 * companyId while a dirty-editor switch is pending confirmation). Child
 * components use this to key the ArtifactEditor so it stays mounted during
 * the guard check, preserving the dirty draft.
 */
export const EffectiveCompanyContext = createContext<string | undefined>(undefined);

export function useEffectiveCompanyId(): string | undefined {
  return useContext(EffectiveCompanyContext);
}

interface CompanySwitchGuardState {
  /** The companyId the URL currently reflects (after guard resolution). */
  effectiveCompanyId: string;
  /** The companyId pending confirmation, or null. */
  pendingCompanyId: string | null;
  /** Error message from a failed save during switch. */
  switchError: string | null;
  /** Whether a save is in-progress during switch. */
  savingSwitch: boolean;
  /** Resolve a pending switch: save, discard, or cancel. */
  resolveSwitch: (action: "save" | "discard" | "cancel") => void;
}

/**
 * Guards company-id transitions from ALL navigation paths (Sidebar clicks,
 * direct URL changes, browser Back/Forward, in-app link clicks). When the URL
 * companyId changes and a dirty artifact editor is open, the hook reverts the
 * URL to keep the editor mounted, surfaces `pendingCompanyId`, and lets the
 * caller show a Save/Discard/Cancel dialog. Only after confirmation does the
 * URL advance to the new company.
 *
 * Designed to be used at the AppShell level so it catches companyId changes
 * regardless of which child route is active.
 */
export function useCompanySwitchGuard(
  urlCompanyId: string,
): CompanySwitchGuardState {
  const navigate = useNavigate();
  const location = useLocation();
  const [effectiveCompanyId, setEffectiveCompanyId] = useState(urlCompanyId);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [savingSwitch, setSavingSwitch] = useState(false);
  const lastValidUrl = useRef(location.pathname + location.search);

  // Detect URL companyId changes
  useEffect(() => {
    if (urlCompanyId === effectiveCompanyId) return;

    const guard = getDirtyEditorGuard();
    if (guard) {
      // Block: revert URL so the editor stays mounted, show dialog
      setPendingUrl(location.pathname + location.search);
      setSwitchError(null);
      navigate(lastValidUrl.current, { replace: true });
    } else {
      // No dirty state — allow the switch
      setEffectiveCompanyId(urlCompanyId);
      lastValidUrl.current = location.pathname + location.search;
    }
  }, [urlCompanyId]);

  const resolveSwitch = useCallback(
    (action: "save" | "discard" | "cancel") => {
      if (!pendingUrl) return;
      const match = pendingUrl.match(/\/company\/([^/?]+)/);
      const pendingId = match?.[1];
      if (!pendingId) return;

      if (action === "cancel") {
        setPendingUrl(null);
        setSwitchError(null);
        return;
      }

      if (action === "discard") {
        const guard = getDirtyEditorGuard();
        guard?.discard();
        setPendingUrl(null);
        setSwitchError(null);
        setEffectiveCompanyId(pendingId);
        lastValidUrl.current = pendingUrl;
        navigate(pendingUrl);
        return;
      }

      // action === "save"
      const guard = getDirtyEditorGuard();
      if (!guard) {
        setPendingUrl(null);
        setEffectiveCompanyId(pendingId);
        lastValidUrl.current = pendingUrl;
        navigate(pendingUrl);
        return;
      }

      setSavingSwitch(true);
      setSwitchError(null);
      void guard
        .save()
        .then((success) => {
          if (success) {
            setPendingUrl(null);
            setEffectiveCompanyId(pendingId);
            lastValidUrl.current = pendingUrl;
            navigate(pendingUrl);
          } else {
            setSwitchError(
              "Save failed. Your draft is preserved. Try again or discard changes.",
            );
          }
        })
        .catch(() => {
          setSwitchError(
            "Save failed. Your draft is preserved. Try again or discard changes.",
          );
        })
        .finally(() => setSavingSwitch(false));
    },
    [pendingUrl, navigate],
  );

  const pendingCompanyId = pendingUrl
    ? pendingUrl.match(/\/company\/([^/?]+)/)?.[1] ?? null
    : null;

  return {
    effectiveCompanyId,
    pendingCompanyId,
    switchError,
    savingSwitch,
    resolveSwitch,
  };
}
