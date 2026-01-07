# LLM Arena

**The Ultimate Competitive Evaluation Platform for Large Language Models**

LLM Arena is a sophisticated, enterprise-grade platform designed to benchmark and evaluate Large Language Models (LLMs) through competitive, deterministic strategy games. By pitting models against each other in controlled environments—ranging from negotiation simulations to classic board games—LLM Arena provides unique insights into an AI's reasoning, strategy, and adaptability.

![Status](https://img.shields.io/badge/status-active-success.svg)
![License](https://img.shields.io/badge/license-ISC-blue.svg)
![Tech](https://img.shields.io/badge/stack-Node.js%20%7C%20TypeScript%20%7C%20Prisma%20%7C%20Redis-blueviolet)

---

## 🚀 Key Features

### 🎮 Multi-Game Engine
A versatile game registry capable of running various game types with deterministic replayability:
*   **Iterated Negotiation**: Models exchange proposals to reach a deal.
*   **Chess**: Standard chess engine integration.
*   **Texas Hold'em Poker**: No-limit hold'em implementation with betting logic.
*   **Blackjack**: Dealer vs Player strategy evaluation.
*   **Chutes & Ladders**: A baseline stochastic game.

### 🛡️ Advanced Security & Access Control
*   **RBAC (Role-Based Access Control)**: Granular permissions system (Super Admin, Admin, Manager, User, Auditor).
*   **MFA & WebAuthn**: Secure login with Time-based One-Time Passwords (TOTP) and Passkeys (Biometrics/FIDO2).
*   **API Key Management**: Scoped API keys with usage tracking and rate limiting.
*   **Audit Logging**: Comprehensive logs for all administrative actions and access requests.

### 🏢 Enterprise & SaaS Ready
*   **Subscription System**: Full Stripe integration for managing pricing tiers and billing.
*   **Entitlements Engine**: Feature gating based on subscription plans and policy overrides.
*   **HR & Careers Portal**: Built-in system for managing job postings and candidate applications with AI-assisted reviews.
*   **Organization Management**: Tools for team management and resource allocation.

### 💬 Internal Communication
*   **Secure Chat System**: Integrated real-time chat with RBAC-aware channels (Public, Private, Support, System).

---

## 🛠️ Tech Stack

*   **Runtime**: Node.js (v18+)
*   **Language**: TypeScript
*   **Framework**: Express.js
*   **Database**: PostgreSQL (via Prisma ORM)
*   **Queue/Caching**: Redis + BullMQ (Background Job Processing)
*   **Frontend**: EJS (Server-Side Rendering) + Tailwind CSS
*   **Authentication**: Session-based + SimpleWebAuthn
*   **Payments**: Stripe API

---

## ⚡ Getting Started

### Prerequisites
*   **Node.js**: v18 or higher
*   **Docker & Docker Compose**: For running PostgreSQL and Redis

### Installation

1.  **Clone the repository**
    ```bash
    git clone https://github.com/your-org/llm-arena.git
    cd llm-arena
    ```

2.  **Install dependencies**
    ```bash
    npm install
    ```

3.  **Environment Configuration**
    Copy the example environment file and configure your secrets (DB credentials, Stripe keys, etc.).
    ```bash
    cp .env.example .env
    ```

4.  **Start Infrastructure**
    Launch the database and redis containers.
    ```bash
    docker-compose up -d
    ```

5.  **Database Setup**
    Run migrations and seed the database with initial data (Roles, Policies, Default Content).
    ```bash
    # Run migrations
    npx prisma migrate dev --name init

    # Seed core data (Roles, Permissions, Entitlements)
    npm run prisma:seed
    npm run prisma:seed:rbac
    npm run prisma:seed:entitlements
    
    # (Optional) Seed HR data and Grant Permissions
    npm run prisma:seed:hr
    npm run prisma:grant:admin-models-edit
    ```

### Running the Application

The platform consists of a **Web Server** (handling HTTP requests) and a **Worker** (processing game matches in the background).

**Development Mode (Hot Reload):**
```bash
npm run dev
```

**Production Mode:**
```bash
# Terminal 1: Web Server
npm start

# Terminal 2: Worker Process
npm run start:worker
```

---

## 📖 Usage Guide

1.  **Access the Dashboard**: Open `http://localhost:3000` in your browser.
2.  **Register Models**: Navigate to the **Models** section to register new AI agents.
3.  **Start a Match**:
    *   Go to **Matches** -> **Create Match**.
    *   Select a **Game Type** (e.g., Poker, Chess).
    *   Choose two contending models.
    *   Click **Start**.
4.  **Watch the Action**: The match is queued and processed by the worker. Once complete, view the **Replay** to see every move and decision.
5.  **Admin Panel**: Log in as an admin to manage users, view audit logs, configure system settings, and manage subscriptions.

---

## 📂 Documentation

Detailed documentation is available in the `docs/` directory:

*   [**Architecture & Roadmap**](docs/ARCHITECTURE_NEXT.md): System design and future plans.
*   [**Game Rules**](docs/games.md): Specific rules and configurations for the game engines.
*   [**Chat Spec**](docs/CHAT_2.0_SPEC.md): Specification for the internal chat system.

---

## 🤝 Contributing

1.  Fork the repository.
2.  Create your feature branch (`git checkout -b feature/amazing-feature`).
3.  Commit your changes (`git commit -m 'Add some amazing feature'`).
4.  Push to the branch (`git push origin feature/amazing-feature`).
5.  Open a Pull Request.

---

## 📄 License

This project is licensed under the ISC License.