# Eidolon v0.2 — UI Restructure, Feature Parity, and pnpm Migration

## Context

Eidolon has 19 pages with significant overlap, a flat sidebar with no grouping, no project management, no toast notifications, no company-switching UX, and basic "AI-generated" design. Paperclip (the reference app) has a clean grouped sidebar, project-centric workflows, real-time toasts, company icons for switching, and polished animations. This plan brings Eidolon to feature parity and beyond.

---

## Phase 1: pnpm Migration

Migrate from npm to pnpm workspaces. Minimal risk, high value for monorepo DX.

**Files to modify:**
- `package.json` (root) — change all `npm -w` to `pnpm --filter`, remove `workspaces` array
- `packages/db/package.json` — `"*"` → `"workspace:*"` for `@eidolon/shared`
- `server/package.json` — `"*"` → `"workspace:*"` for `@eidolon/db`, `@eidolon/shared`
- `.github/workflows/release.yml` — `npm ci` → `pnpm install --frozen-lockfile`, add `pnpm/action-setup`
- `README.md` — update all `npm` commands to `pnpm`

**Files to create:**
- `pnpm-workspace.yaml` with `packages: ["packages/*", "server", "ui"]`

**Files to delete:**
- `package-lock.json`

**Steps:**
1. Create `pnpm-workspace.yaml`
2. Update workspace dependency protocols in package.json files
3. Update root scripts from `npm -w` to `pnpm --filter`
4. Delete `package-lock.json`, run `pnpm install`
5. Update CI workflow
6. Update README
7. Verify: `pnpm run db:generate && pnpm run db:migrate && pnpm run db:seed && pnpm run dev`

---

## Phase 2: Sidebar Restructure & Company Switching

### Current sidebar (15 flat items):
Dashboard, Board Chat, Agents, Tasks, Goals, Org Chart, Messages, Knowledge, Files, Integrations, Prompt Studio, Performance, Workspace, Analytics, Settings

### New sidebar (grouped, inspired by Paperclip):

```
[Company Icons Rail]  ← Left-edge icon strip for company switching (like Paperclip/Slack/Discord)
  [E] Eidolon Demo    ← Active company icon (highlighted)
  [+] Add Company

[MAIN]
  Dashboard
  Inbox               ← NEW: unified notification center (replaces nothing, adds real-time inbox)

[PROJECTS]
  + New Project
  Project A            ← Projects listed inline (like Paperclip)
  Project B

[WORK]
  Issues               ← Renamed from "Tasks" (aligns with Paperclip terminology)
  Goals

[AGENTS]
  Agent Directory      ← Was "Agents"
  Org Chart
  Workspace            ← Virtual workspace (isometric agent view)

[KNOWLEDGE]
  Documents            ← Was "Knowledge" + "Files" merged
  Prompt Studio

[OPERATIONS]
  Analytics            ← Was "Analytics" + "Performance" merged (tabs: Overview | Agent Performance | Costs)
  Integrations
  Settings
```

### Pages consolidated (19 → 13):
| Removed | Merged Into |
|---------|-------------|
| Board Chat | Inbox (chat threads become a tab/section in Inbox) |
| Messages | Inbox (agent-to-agent messages become a tab in Inbox) |
| Files | Documents (merged with Knowledge — files are just another document type) |
| Performance | Analytics (becomes "Agent Performance" tab within Analytics) |

### New pages:
| Page | Purpose |
|------|---------|
| Inbox | Unified notification center: chat threads, agent messages, approvals, alerts |
| Projects (list) | Project directory with status, agent assignments, issue counts |
| Project Detail | Single project view with issues, goals, agents, and activity scoped to project |

### Company switching implementation:
- Add a narrow icon rail (48px) on the far left of the sidebar
- Each company renders as a colored circle with first letter (like Slack workspaces)
- Click to switch — updates URL from `/company/:id` to new company
- `+` button at bottom opens Create Company modal
- Active company highlighted with accent border
- Fetch companies list via existing `GET /api/companies` endpoint

**Critical files:**
- `ui/src/components/layout/Sidebar.tsx` — complete rewrite with grouped sections + icon rail
- `ui/src/components/layout/AppShell.tsx` — add icon rail alongside sidebar
- `ui/src/App.tsx` — update routes (remove merged pages, add new ones)
- `ui/src/lib/hooks.ts` — add `useProjects`, `useProject`, `useInbox` hooks
- `server/src/routes/` — add project routes if not existing

---

## Phase 3: Project-Centric Architecture

Projects are first-class entities. Issues (tasks) and goals belong to projects. Projects belong to companies.

### Database:
- `projects` table already exists with: id, companyId, name, description, status, repoUrl
- `tasks` table already has `projectId` column
- `goals` table needs `projectId` column added

### Server:
- Add `server/src/routes/projects.ts` if not existing — CRUD + list issues/goals per project
- Update goals routes to support `projectId` filter

### UI:
- New `ui/src/pages/ProjectList.tsx` — grid of project cards with status, agent count, issue counts
- New `ui/src/pages/ProjectDetail.tsx` — tabbed view: Issues | Goals | Agents | Activity | Settings
- Issues page (`TaskBoard.tsx`) gains project filter/scope dropdown
- Goals page (`GoalTree.tsx`) gains project filter

---

## Phase 4: Toast System & Real-Time Notifications

### Toast system:
- Install `sonner` (tiny, works with React, great animations)
- Add `<Toaster />` to `AppShell.tsx`
- Wire WebSocket events to toast notifications:
  - `task.created` → "New task: {title}"
  - `task.status_changed` → "Task moved to {status}"
  - `agent.status_changed` → "{name} is now {status}"
  - `execution.completed` → "{agent} completed execution"
  - `budget.alert` → "Budget alert: {message}"

**Files:**
- `ui/src/components/layout/AppShell.tsx` — add `<Toaster />` provider
- `ui/src/lib/ws.ts` — add toast triggers in event handler
- `ui/src/lib/toasts.ts` — NEW: toast helper functions with event-type styling

### Inbox page:
- Unified feed combining: chat messages, agent-to-agent messages, system notifications, approval requests
- Real-time updates via existing WebSocket
- Mark as read/unread, filter by type
- Badge count on sidebar "Inbox" item

---

## Phase 5: Design Polish & Animations

### Animations (using Framer Motion):
- **Page transitions**: `AnimatePresence` + `motion.div` with fade+slide on route changes
- **Sidebar**: smooth expand/collapse with staggered item entrance
- **Cards**: `whileHover` scale(1.01) + border glow, `whileTap` scale(0.99)
- **Modals**: spring-based entrance, backdrop fade
- **Lists**: staggered item entrance (`staggerChildren: 0.05`)
- **Status changes**: color transition animations on badges/indicators
- **Loading states**: skeleton shimmer animations (not just spinners)
- **Kanban columns**: smooth reorder with `layout` animation on drag

### Design system improvements:
- Consistent card depths (surface → raised → overlay)
- Better spacing rhythm (use 4px/8px/12px/16px/24px/32px scale)
- Active states with accent glow on interactive elements
- Micro-interactions: button press, toggle switch, checkbox

**Files:**
- Add `framer-motion` dependency
- `ui/src/components/ui/PageTransition.tsx` — NEW: wrapper for animated route transitions
- `ui/src/components/ui/AnimatedList.tsx` — NEW: staggered list entrance
- `ui/src/components/ui/Skeleton.tsx` — NEW: shimmer loading placeholders
- Update all page components to wrap content in `<PageTransition>`

---

## Phase 6: Paperclip Feature Parity Checklist

Features Paperclip has that Eidolon needs:

| Feature | Eidolon Status | Action |
|---------|---------------|--------|
| Agent heartbeat execution | Has scheduler service | Enhance UI to show heartbeat status, latest run, run history |
| Agent invoke/pause controls | Missing in UI | Add "Invoke" and "Pause" buttons to AgentDetail page |
| Issue checkout semantics | Missing | Add task locking (assignee locks on status → in_progress) |
| Approval workflows | Missing | Phase 7+ (post-MVP) |
| Cost & budget dashboard | Split across Analytics + Settings | Consolidate into Analytics "Costs" tab |
| Search (global) | Missing | Add command palette (Cmd+K) with global search |
| Agent adapter configuration | Has provider/model fields | Enhance AgentDetail with adapter config panel |
| Documentation/wiki per company | Knowledge page exists | Already covered by Documents merge |
| Live status indicators on agents | Has status field | Add pulsing dot animations, "1 live" badge like Paperclip |

---

## Implementation Order

1. **Phase 1: pnpm migration** — 1 hour, unblocks everything
2. **Phase 2: Sidebar restructure** — 1-2 days, biggest UX impact
3. **Phase 3: Projects** — 1 day, adds core missing feature
4. **Phase 4: Toasts + Inbox** — 1 day, real-time polish
5. **Phase 5: Animations** — 1-2 days, design maturity
6. **Phase 6: Feature parity** — 2-3 days, competitive completeness

## Verification

After each phase:
1. `pnpm run dev` — both server and UI start without errors
2. Navigate every sidebar link — no console errors, no failed network requests
3. Test company switching — creates new company, switches between them
4. Test project workflows — create project, assign issues, filter by project
5. Verify toasts fire on: task creation, agent status change, budget alerts
6. Check animations: page transitions, card hovers, list entrances, modal open/close
7. Run `pnpm run typecheck && pnpm run test:run` — all pass
