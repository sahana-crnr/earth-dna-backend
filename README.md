# 🌍 Earth DNA — Backend API

REST API backend for the Earth DNA platform.

**Stack:** NestJS 11 · TypeORM · PostgreSQL 17 · TypeScript 5 · JWT Auth · Swagger/OpenAPI

---

## 📋 Prerequisites

Make sure the following are installed on your machine before you start:

| Tool | Version | Install |
|---|---|---|
| Node.js | ≥ 20 | [nodejs.org](https://nodejs.org) |
| npm | ≥ 10 | Bundled with Node.js |
| Docker | Latest | [docker.com](https://www.docker.com/products/docker-desktop) |
| Docker Compose | Latest | Bundled with Docker Desktop |

---

## 🚀 Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/<your-username>/earth-dna-BE.git
cd earth-dna-BE
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up environment variables

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

Open `.env` and update the values — at minimum set a strong `JWT_SECRET`:

```env
# Application
NODE_ENV=development
PORT=3000
API_PREFIX=api/v1

# Database (matches docker-compose.yml defaults)
DB_HOST=localhost
DB_PORT=5433
DB_USERNAME=postgres
DB_PASSWORD=postgres
DB_NAME=earth_dna

# TypeORM — set true only for local dev, never in production
DB_SYNC=true
DB_LOGGING=true

# JWT
JWT_SECRET=your-super-secret-key-change-this
JWT_EXPIRES_IN=7d
```

> ⚠️ **Never commit your `.env` file.** It is already in `.gitignore`.

---

## 🐘 PostgreSQL with Docker

The project uses Docker to run PostgreSQL 17 locally on **port 5433** (avoids conflicts with any locally installed Postgres on the default 5432).

### Start the database

```bash
npm run db:start
```

This runs `docker compose up -d` in the background. The first run will pull the `postgres:17-alpine` image (~90 MB).

### Verify it's running

```bash
docker ps
# You should see: earth_dna_postgres   postgres:17-alpine   Up
```

### Other database commands

```bash
npm run db:stop    # Stop the container (data is preserved)
npm run db:reset   # ⚠️  Stop + delete all data + restart fresh
```

> **How it works:** Docker Compose mounts a named volume (`postgres_data`) so your data persists across `db:stop` / `db:start` cycles. Only `db:reset` wipes the data.

---

## ▶️ Running the App

Make sure the database is running first (`npm run db:start`), then:

```bash
# Development — watch mode (auto-restarts on file changes)
npm run start:dev

# Production build + run
npm run build
npm run start:prod
```

Once started you'll see:

```
🚀 Application running on: http://localhost:3000/api/v1
📖 Swagger docs:          http://localhost:3000/docs
```

---

## 📖 API Documentation (Swagger)

Interactive API docs are available at:

```
http://localhost:3000/docs
```

### Authenticating in Swagger

1. Use `POST /auth/register` or `POST /auth/login` to get an `accessToken`
2. Click the **Authorize 🔒** button at the top right
3. Paste your token (without the `Bearer ` prefix — Swagger adds it automatically)
4. Click **Authorize** → **Close**
5. Protected endpoints (e.g. `GET /auth/profile`) will now include the token automatically

---

## 🔌 API Endpoints

All routes are prefixed with `/api/v1`.

### Auth

| Method | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/register` | Public | Create a new account |
| `POST` | `/auth/login` | Public | Sign in, receive JWT |
| `POST` | `/auth/forgot-password` | Public | Request password reset email (rate-limited) |
| `POST` | `/auth/reset-password` | Public | Set new password using email token |
| `GET` | `/auth/profile` | 🔒 JWT | Get logged-in user details |

### Request body — Register

```json
{
  "fullName": "Jane Doe",
  "email": "jane@example.com",
  "password": "Password123",
  "country": "USA",
  "zipCode": "10001"
}
```

> `zipCode` is optional. All other fields are required.

### Request body — Login

```json
{
  "email": "jane@example.com",
  "password": "Password123"
}
```

### Password reset (AWS SES)

1. Set `FRONTEND_URL` to your web app (not the API URL).
2. Set `MAIL_DRY_RUN=false` and configure `AWS_SES_FROM_EMAIL`, `AWS_REGION`, and AWS credentials.
3. In **SES sandbox**, verify both sender and recipient emails (same address is fine for testing).
4. Run `npm run verify:ses` (requires [AWS CLI](https://aws.amazon.com/cli/)) or follow [docs/AWS_SES_SETUP.md](docs/AWS_SES_SETUP.md).

Email link format: `{FRONTEND_URL}/reset-password?token=...` — your frontend should POST the token and new password to `/auth/reset-password`.

### Response envelope

Every response is wrapped in a standard envelope:

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": { ... },
  "timestamp": "2026-05-26T10:00:00.000Z"
}
```

---

## 🗄️ Database Migrations

> `DB_SYNC=true` in `.env` auto-syncs the schema locally — no migrations needed for development.
> In staging/production set `DB_SYNC=false` and use migrations.

```bash
# Generate a migration after changing an entity
npm run migration:generate -- src/database/migrations/MigrationName

# Apply all pending migrations
npm run migration:run

# Roll back the last migration
npm run migration:revert

# List all migrations and their status
npm run migration:show
```

---

## 🧪 Tests

```bash
# Unit tests
npm run test

# Unit tests in watch mode
npm run test:watch

# Test coverage report
npm run test:cov

# End-to-end tests
npm run test:e2e
```

---

## 📁 Project Structure

```
src/
├── config/                  # App and database config (registerAs)
├── common/
│   ├── filters/             # Global exception filter
│   ├── interceptors/        # Global response envelope interceptor
│   └── decorators/          # @CurrentUser() param decorator
├── database/
│   ├── data-source.ts       # TypeORM CLI DataSource (migrations)
│   └── migrations/          # Generated migration files
├── auth/
│   ├── dto/                 # RegisterDto, LoginDto, AuthResponseDto
│   ├── guards/              # JwtAuthGuard
│   ├── interfaces/          # AuthResponse type
│   └── auth.module.ts / controller / service
├── user/
│   ├── dto/                 # CreateUserDto
│   ├── entities/            # UserEntity
│   └── user.module.ts / controller / service
├── app.module.ts            # Root module
└── main.ts                  # Bootstrap (Swagger, pipes, guards, filters)
```

---

## 📦 Environment Variables Reference

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | Environment (`development` / `production`) |
| `PORT` | `3000` | HTTP port the app listens on |
| `API_PREFIX` | `api/v1` | Global URL prefix for all routes |
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5433` | PostgreSQL port (5433 for Docker) |
| `DB_USERNAME` | `postgres` | PostgreSQL username |
| `DB_PASSWORD` | `postgres` | PostgreSQL password |
| `DB_NAME` | `earth_dna` | PostgreSQL database name |
| `DB_SYNC` | `false` | Auto-sync schema — `true` for dev only |
| `DB_LOGGING` | `false` | Log SQL queries to console |
| `JWT_SECRET` | — | **Required.** Secret key for signing JWTs |
| `JWT_EXPIRES_IN` | `7d` | JWT expiry (`7d`, `24h`, `3600`, etc.) |

---

## 📜 License

Private — All rights reserved.
