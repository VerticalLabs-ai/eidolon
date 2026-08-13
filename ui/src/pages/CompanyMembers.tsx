import { useParams, Link } from 'react-router-dom';
import { Users, ChevronDown, Trash2, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { useState, useRef, useEffect } from 'react';
import { useCompany, useMembers, useUpdateMemberRole, useRemoveMember } from '@/lib/hooks';
import { usePermission } from '@/lib/permissions';
import { useSession } from '@/lib/auth';
import { PageTransition } from '@/components/ui/PageTransition';
import type { Role } from '@/lib/api';

const ROLE_BADGE_STYLES: Record<
  Role,
  { backgroundColor: string; color: string; borderColor: string }
> = {
  owner: {
    backgroundColor: 'rgba(255, 215, 0, 0.12)',
    color: '#FFD700',
    borderColor: 'rgba(255, 215, 0, 0.25)',
  },
  admin: {
    backgroundColor: 'rgba(59, 130, 246, 0.12)',
    color: '#3B82F6',
    borderColor: 'rgba(59, 130, 246, 0.25)',
  },
  member: {
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    color: '#10B981',
    borderColor: 'rgba(16, 185, 129, 0.25)',
  },
  viewer: {
    backgroundColor: 'rgba(107, 114, 128, 0.12)',
    color: '#9CA3AF',
    borderColor: 'rgba(107, 114, 128, 0.25)',
  },
};

const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

const ROLE_ORDER: Role[] = ['owner', 'admin', 'member', 'viewer'];

function RoleBadge({ role }: { role: Role }) {
  const styles = ROLE_BADGE_STYLES[role];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium leading-tight border"
      style={styles}
      data-role={role}
    >
      {ROLE_LABELS[role]}
    </span>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) {return iso;}
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function displayName(userId: string): string {
  // In local_trusted mode, userIds are like "dev-user-000".
  // Produce a readable label; the server doesn't return Clerk user names
  // for members yet, so we derive a fallback from the userId.
  if (userId.startsWith('dev-user-')) {
    const num = userId.replace('dev-user-', '');
    return `Dev User ${num}`;
  }
  return userId;
}

export function CompanyMembers() {
  const { companyId } = useParams();
  const { data: company } = useCompany(companyId);
  const { data: members, isLoading } = useMembers(companyId);
  const { role, isLoading: roleLoading } = usePermission(companyId);
  const updateRoleMutation = useUpdateMemberRole(companyId!);
  const removeMemberMutation = useRemoveMember(companyId!);
  const session = useSession();
  const currentUserId = session.data?.user?.id ?? null;

  const canPromote = role === 'owner';
  const canRemove = role === 'owner' || role === 'admin';

  const sortedMembers = [...(members ?? [])].sort((a, b) => {
    // Sort by role hierarchy (owner first), then by createdAt
    const aIdx = ROLE_ORDER.indexOf(a.role);
    const bIdx = ROLE_ORDER.indexOf(b.role);
    if (aIdx !== bIdx) {return aIdx - bIdx;}
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  return (
    <PageTransition>
      <div className="mx-auto max-w-3xl p-6 lg:p-8 space-y-6">
        {/* Header with back link */}
        <div>
          <Link
            to={`/company/${companyId}/settings`}
            className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-accent transition-colors mb-3"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Settings
          </Link>
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-accent" />
            <h2 className="font-display text-2xl font-bold text-text-primary tracking-tight">
              Members &amp; Roles
            </h2>
          </div>
          <p className="text-sm text-text-secondary mt-1">
            {company ? `Manage members for ${company.name}` : 'Loading company...'}
          </p>
        </div>

        {/* Member list */}
        <div className="glass rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.06]">
            <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
              Members
              {members && <span className="text-text-secondary ml-2">({members.length})</span>}
            </h3>
          </div>

          {isLoading ? (
            <div className="flex h-32 items-center justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
            </div>
          ) : !sortedMembers.length ? (
            <div className="py-12 text-center">
              <Users className="h-8 w-8 text-text-secondary/30 mx-auto mb-3" />
              <p className="text-sm text-text-secondary">No members found.</p>
            </div>
          ) : (
            <ul className="divide-y divide-white/[0.04]" role="list">
              {sortedMembers.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  canPromote={canPromote}
                  canRemove={canRemove}
                  currentUserId={currentUserId}
                  onUpdateRole={(newRole) =>
                    updateRoleMutation.mutate(
                      { memberId: member.id, role: newRole },
                      {
                        onSuccess: () => toast.success(`Role updated to ${ROLE_LABELS[newRole]}`),
                        onError: (err) =>
                          toast.error(err instanceof Error ? err.message : 'Failed to update role'),
                      },
                    )
                  }
                  onRemove={() => {
                    if (window.confirm(`Remove ${displayName(member.userId)} from this company?`)) {
                      removeMemberMutation.mutate(member.id, {
                        onSuccess: () => toast.success('Member removed'),
                        onError: (err) =>
                          toast.error(
                            err instanceof Error ? err.message : 'Failed to remove member',
                          ),
                      });
                    }
                  }}
                  isUpdating={updateRoleMutation.isPending}
                  isRemoving={removeMemberMutation.isPending}
                />
              ))}
            </ul>
          )}
        </div>

        {roleLoading && (
          <p className="text-xs text-text-secondary text-center">Loading your permissions...</p>
        )}
      </div>
    </PageTransition>
  );
}

function MemberRow({
  member,
  canPromote,
  canRemove,
  currentUserId,
  onUpdateRole,
  onRemove,
  isUpdating,
  isRemoving,
}: {
  member: {
    id: string;
    userId: string;
    role: Role;
    createdAt: string;
  };
  canPromote: boolean;
  canRemove: boolean;
  currentUserId: string | null;
  onUpdateRole: (role: Role) => void;
  onRemove: () => void;
  isUpdating: boolean;
  isRemoving: boolean;
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const name = displayName(member.userId);
  const initials = name.slice(0, 2).toUpperCase();

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) {return;}
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  // Hide remove button on self — server enforces last-owner protection,
  // but we also hide it to avoid confusion
  const isSelf = currentUserId === member.userId;

  return (
    <li className="flex items-center gap-4 px-6 py-4 transition-colors hover:bg-white/[0.02]">
      {/* Avatar */}
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/10 text-sm font-medium text-accent"
        aria-hidden="true"
      >
        {initials}
      </div>

      {/* Name + joined date */}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-primary truncate">{name}</p>
        <p className="text-xs text-text-secondary mt-0.5">Joined {formatDate(member.createdAt)}</p>
      </div>

      {/* Role badge */}
      <RoleBadge role={member.role} />

      {/* Actions */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Promote/demote dropdown — owner only */}
        {canPromote && (
          <div className="relative" ref={dropdownRef}>
            <button
              type="button"
              onClick={() => setDropdownOpen(!dropdownOpen)}
              disabled={isUpdating}
              className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-white/[0.06] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 cursor-pointer"
              aria-label={`Change role for ${name}`}
              data-action="role-change"
            >
              <ChevronDown className="h-3 w-3" />
              Role
            </button>
            {dropdownOpen && (
              <div className="absolute right-0 top-full z-20 mt-1 w-36 rounded-lg border border-white/[0.08] bg-surface-raised shadow-xl py-1">
                {ROLE_ORDER.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => {
                      setDropdownOpen(false);
                      onUpdateRole(r);
                    }}
                    className={`flex w-full items-center justify-between px-3 py-1.5 text-xs transition-colors hover:bg-white/[0.04] ${
                      member.role === r ? 'text-accent font-medium' : 'text-text-secondary'
                    } cursor-pointer`}
                  >
                    {ROLE_LABELS[r]}
                    {member.role === r && <span className="text-accent">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Remove button — owner + admin */}
        {canRemove && !isSelf && (
          <button
            type="button"
            onClick={onRemove}
            disabled={isRemoving}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-error/10 hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 cursor-pointer"
            aria-label={`Remove ${name} from company`}
            title="Remove member"
            data-action="remove-member"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </li>
  );
}
