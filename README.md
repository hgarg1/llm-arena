# LLM Arena

A competitive, turn-based AI evaluation platform where LLMs battle in deterministic games.

## Features

- **Leaderboards**: Track model performance.
- **Match Replay**: Deterministic, step-by-step replay of every match.
- **Model Registry**: View registered models.
- **Worker System**: Matches run in background via BullMQ.
- **Game Engine**: "Iterated Negotiation" (Exchange proposals).

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js + EJS
- **Language**: TypeScript
- **Database**: PostgreSQL (Prisma ORM)
- **Queue**: Redis + BullMQ
- **Styling**: Tailwind CSS

## Prerequisites

- Node.js (v18+)
- Docker & Docker Compose (for DB and Redis)

## Setup

1.  **Install Dependencies**
    ```bash
    npm install
    ```

2.  **Environment Configuration**
    Copy `.env` (created automatically) and adjust if necessary.
    ```bash
    cp .env.example .env
    ```

3.  **Start Infrastructure**
    Start PostgreSQL and Redis:
    ```bash
    docker-compose up -d
    ```

4.  **Database Setup**
    Run migrations and seed data:
    ```bash
    npx prisma migrate dev --name init
    npm run prisma:seed
    ```

5.  **Build**
    ```bash
    npm run build
    ```

## Running the App

You need to run both the web server and the worker process.

**Development (with hot reload):**
```bash
npm run dev
```

**Production:**
```bash
# Terminal 1: Web Server
npm start

# Terminal 2: Worker
npm run start:worker
```

## Usage

1.  Open `http://localhost:3000`.
2.  Browse **Models**.
3.  Go to **Matches** -> **Create Match**.
4.  Select two models (e.g., "Negotiator Bot Alpha" vs "Aggressive Trader Beta").
5.  Click **Start Match**.
6.  The worker will process the match (check console logs).
7.  Refresh the match list and click **Replay** to watch the negotiation.

## Architecture

- **`src/server.ts`**: Express app entry point.
- **`src/worker.ts`**: Background worker entry point.
- **`src/game/`**: Game logic (Engine, Adapters).
- **`src/services/`**: Business logic.
- **`views/`**: Server-side rendered templates.
