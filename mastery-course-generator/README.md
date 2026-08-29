# KLAXO

> **AI-powered curriculum engineering platform** — transforms raw educational material into structured, grounded, mastery-oriented courses using FCC Server NVIDIA NIM models.

---

## Production architecture

KLAXO is designed to keep web requests short-lived and generation work durable. The web tier creates persisted jobs, while one or more worker processes claim jobs through the shared execution lease. Heartbeats prevent false recovery while long-running model calls are active, and cancellation/recovery state is persisted in the database.

For the current repository, the supported production topology is **a horizontally replicated web tier only when all replicas share the same persistent SQLite volume**. The generation worker remains a separate process. SQLite is still a single-writer database, so this is a robust single-writer production deployment, not a multi-region PostgreSQL deployment.

### Production container

The repository now includes a multi-stage `Dockerfile` with separate `runner` and `worker` targets and a `docker-compose.production.yml` example that mounts durable `/app/data` and `/app/uploads` volumes.

```bash
cp .env.example .env
# Set NODE_ENV=production, AI_DEV_MODE=false, FCC_SERVER_API_KEY, APP_SECRET

docker compose -f docker-compose.production.yml up --build -d
```

The web container exposes:

- `GET /api/health` — liveness probe; only checks that the process is serving requests.
- `GET /api/ready` — readiness probe; validates environment configuration and database connectivity.

Use the liveness probe for container restart decisions and the readiness probe for traffic routing.

### Worker operations

Run workers separately from the web tier. `WORKER_CONCURRENCY` bounds the number of jobs each worker can execute concurrently, while the shared job lease prevents duplicate execution across multiple workers. Workers handle `SIGTERM`/`SIGINT` and exit cleanly; incomplete work remains persisted for recovery.

```bash
npm run worker
```

### Database

- **Development**: SQLite file (`./data/mastery.db`) — auto-created.
- **Production (current)**: SQLite on a durable persistent volume. WAL mode, busy timeouts, foreign keys, durable journaling, and automatic checkpointing are enabled.

A true horizontally scalable / multi-region production deployment still requires migrating the repository layer from synchronous SQLite access to an asynchronous PostgreSQL driver and moving uploaded files to shared object storage. The current code does **not** claim that capability.

### Security requirements

Production startup now fails fast unless:

- `NODE_ENV=production`
- `AI_DEV_MODE=false`
- a real `FCC_SERVER_API_KEY` is configured
- `APP_SECRET` is at least 32 characters
- `DATABASE_FILE` is not `:memory:`

Uploaded source files are stored outside the immutable application image, and sensitive AI credentials remain server-side only.

---

## Product overview

KLAXO takes messy educational inputs (syllabus photos, PDFs, lecture notes, textbook material, natural-language prompts) and produces a structured course with:

- **Course architecture** — units, topics, measurable learning objectives
- **Lessons** — explanations, worked examples, visual specifications, misconceptions
- **Practice** — progressive levels from recognition to challenge
- **Assessments** — aligned to objectives with distractor analysis
- **Mastery tracking** — evidence-based progression with spaced review
- **Provenance** — every element traced back to source material
- **Quality assurance** — automated checks with targeted revision loops
- **Versioning** — immutable published versions with restore/compare
- **Interactive workspace** — lessons, practice, assessments, mastery in one view

---

## Tech stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4 |
| Backend | Next.js API Routes, TypeScript |
| Database | SQLite via `better-sqlite3` + Drizzle ORM |
| AI | NVIDIA NIM models via FCC Server (OpenAI-compatible API) |
| Schema Validation | Zod |
| Testing | Vitest |
| CI/CD | GitHub Actions |
| Deployment | Multi-stage Docker + separate durable worker |

---

## Setup

### Prerequisites

- Node.js 20+
- npm 10+

### Installation

```bash
git clone <repo-url>
cd mastery-course-generator
npm install
```

### Development

```bash
npm run dev
# In another terminal
npm run worker
```

The default development configuration uses deterministic mock AI fixtures and local SQLite.

### Production

```bash
cp .env.example .env
# Edit .env with real production secrets
npm run build
npm run start
# Run the worker separately
npm run worker
```

For container deployment, prefer `docker compose -f docker-compose.production.yml up --build -d` so the web and worker processes have separate lifecycle management while sharing their durable data volumes.
