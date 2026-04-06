# Eidolon — The AI Company Runtime

**Open-source orchestration platform for autonomous AI companies.**

Eidolon lets you define a business goal, hire AI agents from any provider (Anthropic, OpenAI, Google, local models), organize them into an org chart, set budgets, and manage their work through a ticket-based system — all from one dashboard.

## Features

| Feature                   | Description                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| **Multi-Provider Agents** | Hire agents from Anthropic, OpenAI, Google, or any custom provider. One unified interface. |
| **Org Chart & Hierarchy** | Agents have roles, titles, and reporting lines. Delegation flows naturally.                |
| **Task Board**            | Kanban-style task management. Assign, track, and review agent work like JIRA for AIs.      |
| **Goal Alignment**        | OKR-style goal hierarchy. Every task traces back to the company mission.                   |
| **Budget Control**        | Per-agent monthly budgets with real-time cost tracking and alerts.                         |
| **Workflow Engine**       | DAG-based workflows with task dependencies and automatic orchestration.                    |
| **Inter-Agent Messaging** | Agents communicate directly. Escalations flow up the org chart.                            |
| **Real-Time Dashboard**   | WebSocket-powered live updates. Monitor everything from your phone.                        |
| **Analytics**             | Cost trends, agent efficiency, task throughput, and budget utilization.                    |
| **Activity Audit Log**    | Every action tracked. Full transparency and accountability.                                |
| **Multi-Company**         | Run multiple autonomous companies from one deployment.                                     |

## Quickstart

```bash
git clone https://github.com/VerticalLabs-ai/eldolon.git
cd eldolon
npm install
npm run db:generate  # Generate migration SQL from schema
npm run db:migrate
npm run db:seed      # Optional: load demo data
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) for the dashboard.
API runs at [http://localhost:3100](http://localhost:3100).

**Requirements:** Node.js 20+

## Architecture

```
eidolon/
├── packages/
│   ├── shared/     # Types, Zod schemas, constants
│   └── db/         # Drizzle ORM, SQLite, migrations, seed
├── server/         # Express API + WebSocket server
│   ├── routes/     # REST API endpoints
│   ├── services/   # Orchestration engine, budget enforcer
│   └── realtime/   # WebSocket event system
└── ui/             # React 19 + Vite + Tailwind dashboard
    ├── pages/      # Dashboard, TaskBoard, OrgChart, Analytics...
    ├── components/ # Reusable UI components
    └── lib/        # API client, WebSocket hooks, React Query
```

## Tech Stack

- **Backend:** Node.js, Express 5, TypeScript
- **Database:** SQLite via Drizzle ORM (zero-config, embedded)
- **Frontend:** React 19, Vite, Tailwind CSS v4, TanStack React Query
- **Real-time:** WebSocket (ws) with typed events
- **Validation:** Zod schemas shared between client and server

## Development

```bash
npm run dev           # Start server + UI in dev mode
npm run dev:server    # Server only
npm run dev:ui        # UI only
npm run build         # Build everything
npm run typecheck     # Type check all packages
npm run test          # Run tests
npm run db:generate   # Generate migration SQL from schema
npm run db:migrate    # Run database migrations
npm run db:seed       # Seed demo data
```

## How It Works

1. **Create a Company** — Define your business mission and budget
2. **Hire Agents** — Add AI agents with specific roles (CEO, CTO, Engineer, etc.)
3. **Set Goals** — Define OKRs that cascade from mission to tasks
4. **Manage Tasks** — Create and assign tasks on the kanban board
5. **Monitor** — Watch agents work in real-time, review output, control costs

## API Overview

All endpoints under `/api`:

| Endpoint                             | Description         |
| ------------------------------------ | ------------------- |
| `GET /api/companies`                 | List companies      |
| `POST /api/companies`                | Create company      |
| `GET /api/companies/:id/agents`      | List agents         |
| `POST /api/companies/:id/agents`     | Hire agent          |
| `GET /api/companies/:id/tasks`       | List tasks          |
| `POST /api/companies/:id/tasks`      | Create task         |
| `GET /api/companies/:id/goals`       | List goals          |
| `GET /api/companies/:id/analytics/*` | Analytics endpoints |
| `WS /ws`                             | Real-time events    |

## Releases

Versions follow **Calendar Versioning (CalVer)** using the **UTC** calendar date: `YYYY.M.D` with no zero-padding on month or day (for example `2026.4.6`).

- The **first** successful release on a given UTC day is tagged exactly as that date.
- **Additional** releases on the **same UTC day** use a numeric suffix: `2026.4.6-2`, `2026.4.6-3`, and so on.

Each push to `main` that passes CI (typecheck, tests, build) triggers [`.github/workflows/release.yml`](.github/workflows/release.yml): a new Git tag is created and a **GitHub Release** is published with auto-generated notes. Workspace `package.json` versions are not bumped; the tag and release are the public version.

## License

MIT
