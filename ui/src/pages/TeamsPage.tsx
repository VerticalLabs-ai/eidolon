import { useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Users, Plus, Trash2, UserPlus, UserMinus, Shield } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useTeams, useCreateTeam, useDeleteTeam, useTeamMembers, useAddTeamMember, useRemoveTeamMember } from "@/lib/hooks";
import { useServerEvents } from "@/lib/ws";
import { useQueryClient } from "@tanstack/react-query";
import type { Team, TeamMember } from "@/lib/api";

export function TeamsPage() {
  const { companyId = "" } = useParams();
  const { data: teams = [], isLoading } = useTeams(companyId);
  const createMutation = useCreateTeam(companyId);
  const deleteMutation = useDeleteTeam(companyId);
  const [showCreate, setShowCreate] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null);
  const [showAddMember, setShowAddMember] = useState(false);
  const [newMemberUserId, setNewMemberUserId] = useState("");
  const qc = useQueryClient();

  // Live-update on team events
  useServerEvents(companyId, "team.created", () => qc.invalidateQueries({ queryKey: ["teams", companyId] }));
  useServerEvents(companyId, "team.deleted", () => qc.invalidateQueries({ queryKey: ["teams", companyId] }));
  useServerEvents(companyId, "team.member.added", () => {
    qc.invalidateQueries({ queryKey: ["teams", companyId] });
    if (expandedTeamId) qc.invalidateQueries({ queryKey: ["teams", companyId, expandedTeamId, "members"] });
  });
  useServerEvents(companyId, "team.member.removed", () => {
    qc.invalidateQueries({ queryKey: ["teams", companyId] });
    if (expandedTeamId) qc.invalidateQueries({ queryKey: ["teams", companyId, expandedTeamId, "members"] });
  });

  const handleCreate = useCallback(async () => {
    if (!newTeamName.trim()) return;
    try {
      await createMutation.mutateAsync(newTeamName.trim());
      toast.success("Team created");
      setNewTeamName("");
      setShowCreate(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Create failed";
      toast.error(msg);
    }
  }, [createMutation, newTeamName]);

  const handleDelete = useCallback(async (teamId: string, name: string) => {
    if (!confirm(`Delete team "${name}"? This will revoke all permissions granted to this team.`)) return;
    try {
      await deleteMutation.mutateAsync(teamId);
      toast.success("Team deleted");
      if (expandedTeamId === teamId) setExpandedTeamId(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Delete failed";
      toast.error(msg);
    }
  }, [deleteMutation, expandedTeamId]);

  return (
    <div className="p-5 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-accent" />
            <h2 className="text-sm font-semibold text-text-primary font-display">Teams</h2>
          </div>
          <Button
            variant="primary"
            size="md"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={() => setShowCreate(true)}
          >
            New Team
          </Button>
        </div>

        {showCreate && (
          <div className="rounded-xl border border-white/[0.06] bg-surface/60 p-4">
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <label className="mb-1 block text-xs text-text-secondary">Team name</label>
                <input
                  type="text"
                  value={newTeamName}
                  onChange={(e) => setNewTeamName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                  placeholder="e.g. Engineering Team"
                  className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:border-accent/40 focus:outline-none focus:ring-2 focus:ring-accent/20"
                  autoFocus
                />
              </div>
              <Button variant="primary" size="md" onClick={handleCreate} disabled={!newTeamName.trim() || createMutation.isPending}>
                Create
              </Button>
              <Button variant="ghost" size="md" onClick={() => { setShowCreate(false); setNewTeamName(""); }}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
          </div>
        ) : teams.length === 0 ? (
          <EmptyState
            icon={<Users className="h-6 w-6" />}
            title="No teams yet"
            description="Create a team to group members and grant them shared permissions."
          />
        ) : (
          <ul className="space-y-2" role="list">
            {teams.map((team: Team) => (
              <TeamRow
                key={team.id}
                companyId={companyId}
                team={team}
                expanded={expandedTeamId === team.id}
                onToggle={() => setExpandedTeamId(expandedTeamId === team.id ? null : team.id)}
                onDelete={() => handleDelete(team.id, team.name)}
                showAddMember={showAddMember && expandedTeamId === team.id}
                onToggleAddMember={() => setShowAddMember(!showAddMember)}
                newMemberUserId={newMemberUserId}
                setNewMemberUserId={setNewMemberUserId}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TeamRow({
  companyId,
  team,
  expanded,
  onToggle,
  onDelete,
  showAddMember,
  onToggleAddMember,
  newMemberUserId,
  setNewMemberUserId,
}: {
  companyId: string;
  team: Team;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  showAddMember: boolean;
  onToggleAddMember: () => void;
  newMemberUserId: string;
  setNewMemberUserId: (v: string) => void;
}) {
  const { data: members = [] } = useTeamMembers(companyId, expanded ? team.id : undefined);
  const addMemberMutation = useAddTeamMember(companyId, team.id);
  const removeMemberMutation = useRemoveTeamMember(companyId, team.id);

  const handleAddMember = useCallback(async () => {
    if (!newMemberUserId.trim()) return;
    try {
      await addMemberMutation.mutateAsync(newMemberUserId.trim());
      setNewMemberUserId("");
      onToggleAddMember();
      toast.success("Member added");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Add failed";
      toast.error(msg);
    }
  }, [addMemberMutation, newMemberUserId, setNewMemberUserId, onToggleAddMember]);

  const handleRemoveMember = useCallback(async (userId: string) => {
    try {
      await removeMemberMutation.mutateAsync(userId);
      toast.success("Member removed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Remove failed";
      toast.error(msg);
    }
  }, [removeMemberMutation]);

  return (
    <li className="rounded-xl border border-white/[0.06] bg-surface/60">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          onClick={onToggle}
          className="flex flex-1 items-center gap-3 text-left"
          aria-expanded={expanded}
          aria-label={`Toggle team ${team.name}`}
        >
          <Shield className="h-4 w-4 text-accent/70" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-text-primary">{team.name}</p>
            <p className="text-xs text-text-secondary mt-0.5">
              {team.memberCount ?? 0} member{(team.memberCount ?? 0) !== 1 ? "s" : ""}
            </p>
          </div>
        </button>
        <button
          onClick={onDelete}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:text-red-400 hover:bg-red-500/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 cursor-pointer"
          aria-label={`Delete team ${team.name}`}
          title="Delete team"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {expanded && (
        <div className="border-t border-white/[0.06] px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-xs font-medium text-text-secondary">Members</h4>
            <button
              onClick={onToggleAddMember}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 cursor-pointer"
            >
              <UserPlus className="h-3 w-3" />
              Add member
            </button>
          </div>
          {showAddMember && (
            <div className="mb-3 flex items-end gap-2">
              <input
                type="text"
                value={newMemberUserId}
                onChange={(e) => setNewMemberUserId(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddMember()}
                placeholder="User ID"
                className="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm text-text-primary placeholder:text-text-secondary focus:border-accent/40 focus:outline-none focus:ring-2 focus:ring-accent/20"
                autoFocus
              />
              <Button variant="primary" size="sm" onClick={handleAddMember} disabled={!newMemberUserId.trim() || addMemberMutation.isPending}>
                Add
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { onToggleAddMember(); setNewMemberUserId(""); }}>
                Cancel
              </Button>
            </div>
          )}
          {members.length === 0 ? (
            <p className="text-xs text-text-secondary py-2">No members yet.</p>
          ) : (
            <ul className="space-y-1" role="list">
              {members.map((member: TeamMember) => (
                <li key={member.id} className="flex items-center gap-2 py-1">
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/10 text-xs text-accent">
                    {member.userId.slice(0, 2).toUpperCase()}
                  </div>
                  <span className="flex-1 truncate text-xs text-text-primary font-mono">{member.userId}</span>
                  <button
                    onClick={() => handleRemoveMember(member.userId)}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-text-secondary hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                    aria-label={`Remove member ${member.userId}`}
                  >
                    <UserMinus className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
