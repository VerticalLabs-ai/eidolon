import { useState, useCallback } from "react";
import { X, Shield, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { usePermissions, useGrantPermission, useRevokePermission, useTeams } from "@/lib/hooks";
import type { PermissionResourceType, AccessLevel, GranteeType, PermissionRecord, Team } from "@/lib/api";

interface PermissionManagerProps {
  companyId: string;
  resourceType: PermissionResourceType;
  resourceId: string;
  resourceLabel: string;
  onClose: () => void;
}

const LEVEL_LABELS: Record<AccessLevel, string> = {
  view: "View",
  edit: "Edit",
  manage: "Manage",
};

export function PermissionManager({
  companyId,
  resourceType,
  resourceId,
  resourceLabel,
  onClose,
}: PermissionManagerProps) {
  const { data: permissions = [], isLoading } = usePermissions(companyId, resourceType, resourceId);
  const { data: teams = [] } = useTeams(companyId);
  const grantMutation = useGrantPermission(companyId);
  const revokeMutation = useRevokePermission(companyId);

  const [granteeType, setGranteeType] = useState<GranteeType>("user");
  const [granteeId, setGranteeId] = useState("");
  const [accessLevel, setAccessLevel] = useState<AccessLevel>("view");

  const handleGrant = useCallback(async () => {
    if (!granteeId.trim()) return;
    try {
      await grantMutation.mutateAsync({
        resourceType, resourceId, granteeType,
        granteeId: granteeId.trim(), accessLevel,
      });
      toast.success("Permission granted");
      setGranteeId("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Grant failed";
      toast.error(msg);
    }
  }, [grantMutation, resourceType, resourceId, granteeType, granteeId, accessLevel]);

  const handleRevoke = useCallback(async (perm: PermissionRecord) => {
    try {
      await revokeMutation.mutateAsync({
        resourceType: perm.resourceType, resourceId: perm.resourceId,
        granteeType: perm.granteeType, granteeId: perm.granteeId,
        accessLevel: perm.accessLevel,
      });
      toast.success("Permission revoked");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Revoke failed";
      toast.error(msg);
    }
  }, [revokeMutation]);

  const granteeLabel = (perm: PermissionRecord): string => {
    if (perm.granteeType === "team") {
      const team = teams.find((t: Team) => t.id === perm.granteeId);
      return team ? `Team: ${team.name}` : `Team: ${perm.granteeId.slice(0, 8)}...`;
    }
    return `User: ${perm.granteeId.slice(0, 12)}...`;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Manage permissions for ${resourceLabel}`}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-white/10 bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-accent" />
            <h3 className="text-sm font-semibold text-text-primary font-display">
              Permissions — {resourceLabel}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:text-text-primary hover:bg-white/5 transition-colors cursor-pointer"
            aria-label="Close permission manager"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Current permissions */}
        <div className="mb-4">
          <h4 className="mb-2 text-xs font-medium text-text-secondary">Current grants</h4>
          {isLoading ? (
            <p className="text-xs text-text-secondary">Loading...</p>
          ) : permissions.length === 0 ? (
            <p className="text-xs text-text-secondary py-2">
              No explicit grants. All company members have default access based on their role.
            </p>
          ) : (
            <ul className="space-y-1" role="list">
              {permissions.map((perm: PermissionRecord) => (
                <li key={perm.id} className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                  <span className="flex-1 truncate text-xs text-text-primary">{granteeLabel(perm)}</span>
                  <span className="rounded-md bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
                    {LEVEL_LABELS[perm.accessLevel]}
                  </span>
                  <button
                    onClick={() => handleRevoke(perm)}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-text-secondary hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                    aria-label={`Revoke permission for ${granteeLabel(perm)}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Grant new permission */}
        <div className="border-t border-white/[0.06] pt-4">
          <h4 className="mb-2 text-xs font-medium text-text-secondary">Grant new permission</h4>
          <div className="space-y-2">
            <div className="flex gap-2">
              <select
                value={granteeType}
                onChange={(e) => { setGranteeType(e.target.value as GranteeType); setGranteeId(""); }}
                className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-xs text-text-primary focus:border-accent/40 focus:outline-none focus:ring-2 focus:ring-accent/20"
                aria-label="Grantee type"
              >
                <option value="user">User</option>
                <option value="team">Team</option>
              </select>
              {granteeType === "team" ? (
                <select
                  value={granteeId}
                  onChange={(e) => setGranteeId(e.target.value)}
                  className="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-xs text-text-primary focus:border-accent/40 focus:outline-none focus:ring-2 focus:ring-accent/20"
                  aria-label="Select team"
                >
                  <option value="">Select a team...</option>
                  {teams.map((t: Team) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={granteeId}
                  onChange={(e) => setGranteeId(e.target.value)}
                  placeholder="User ID"
                  className="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-text-primary placeholder:text-text-secondary focus:border-accent/40 focus:outline-none focus:ring-2 focus:ring-accent/20"
                  aria-label="User ID"
                />
              )}
              <select
                value={accessLevel}
                onChange={(e) => setAccessLevel(e.target.value as AccessLevel)}
                className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-xs text-text-primary focus:border-accent/40 focus:outline-none focus:ring-2 focus:ring-accent/20"
                aria-label="Access level"
              >
                <option value="view">View</option>
                <option value="edit">Edit</option>
                <option value="manage">Manage</option>
              </select>
            </div>
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="h-3 w-3" />}
              onClick={handleGrant}
              disabled={!granteeId.trim() || grantMutation.isPending}
              className="w-full"
            >
              Grant Permission
            </Button>
          </div>
        </div>

        <p className="mt-4 text-xs text-text-secondary">
          Granting a permission restricts this resource: only grantees (and company admins/owners) will have access.
        </p>
      </div>
    </div>
  );
}
