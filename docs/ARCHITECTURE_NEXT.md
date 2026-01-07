# Architecture Next: Documentation, Chat, and Admin UX

This document outlines the architectural plans for three key systems:
1.  **Auto-Updating Documentation Pipeline**
2.  **Internal Chat System (RBAC & Entitlement Aware)**
3.  **Admin Portal UX Improvements (Empty States)**

---

## 1. Auto-Updating Documentation Pipeline

### Goal
Ensure documentation (APIs, SDKs, Game Rules) is always in sync with the codebase by deriving it from source-of-truth definitions (Code, Schemas, Registries).

### Architecture

The documentation system will use a "Generate & Build" pipeline that runs during CI/CD or via a manual `npm run docs:build` command.

#### Sources of Truth

| Domain | Source | Extraction Method |
| :--- | :--- | :--- |
| **HTTP API** | `src/routes/*.ts` | `swagger-jsdoc` annotations or `tsoa` reflection. |
| **Data Models** | `prisma/schema.prisma` | `prisma-docs-generator` or custom script parsing DMMF. |
| **Game Rules** | `src/game/registry.ts` & `DB: GameDefinition` | Custom script importing the registry and fetching active GameDefinitions. |
| **SDKs** | `packages/*/package.json` | `typedoc` for TypeScript SDKs. |

#### Pipeline Steps

1.  **Extraction**: Scripts run to extract metadata from sources.
    *   `scripts/docs/generate-api.ts`: Generates `openapi.json`.
    *   `scripts/docs/generate-engine.ts`: Instantiates the Game Registry, iterates available games, and dumps their rules/prompts/config to Markdown.
2.  **Transformation**: Convert raw data (JSON/OpenAPI) into presentable content (Markdown/MDX).
3.  **Presentation**: A static site generator (e.g., Docusaurus, VitePress) consumes the Markdown.

#### Taxonomy

*   **Public Docs**: Open to everyone. Contains Marketing info, basic Game Rules.
*   **Developer Docs**: Requires API Key authentication (conceptually). Contains OpenAPI spec, SDK reference.
*   **Internal/Admin Docs**: Requires Admin Login. Contains System Architecture, Deployment guides, Private Game Rules.

### Game Rules Integration

Game rules are dynamic. They are defined in code (`src/game/*`) but configured in DB (`GameDefinition`).
The docs generator will:
1.  Connect to the (dev/read-only) DB.
2.  Fetch all `PUBLISHED` `GameDefinition`s.
3.  Render their `description_long`, `rules` (from settings), and `scoring` logic into a "Game Rules Registry" page.

---

## 2. Internal Chat System

### Goal
A secure, RBAC-integrated chat platform for Admins and Users, supporting support tickets, operations, and community channels.

### Data Model

New Prisma entities will be added:

*   **ChatChannel**: Represents a room.
    *   `type`: `PUBLIC`, `PRIVATE`, `SUPPORT`, `SYSTEM`
    *   `min_role`: Minimum RBAC role required to view.
    *   `required_entitlement`: Entitlement key required (e.g., `feature_priority_support`).
*   **ChatParticipant**: Links User to Channel.
    *   `role`: `OWNER`, `ADMIN`, `MEMBER`, `READONLY`.
*   **ChatMessage**: The content.
    *   `type`: `TEXT`, `SYSTEM`, `IMAGE`.
    *   `is_pinned`: Boolean.

### RBAC & Entitlements Integration

*   **Access Control**:
    *   Middleware `canAccessChannel(user, channel)` checks:
        1.  Is User Banned?
        2.  Does User have `channel.min_role`?
        3.  Does User have `channel.required_entitlement`?
    *   **Support Channels**: Created automatically for users with `pro` tier. Admins are auto-added via a background job or dynamic query.

### Real-time Strategy

*   **Phase 1 (MVP)**: Polling (Short interval). Reliable, easy to implement in Express.
*   **Phase 2**: Socket.io or Server-Sent Events (SSE) for instant delivery.

---

## 3. Admin UX: Empty States

### Goal
Eliminate "blank white pages" when no data exists. Empty states should educate and guide.

### Design Pattern

Every list view (e.g., Models, Users, Matches) checks if the dataset is empty. If so, render a consistent **Empty State Component**:

*   **Icon**: Relevant to the entity (e.g., a Cube for Models).
*   **Title**: "No Models Found".
*   **Description**: "Models are the AI agents that play games. You haven't added any yet."
*   **Primary Action**: "Create Model" button.
*   **Secondary Action**: "Read Documentation" or "Import Defaults".
*   **Status**: "System Ready" (green dot) or "Configuration Needed" (orange dot).

### Implementation

A reusable EJS partial: `views/partials/admin/empty-state.ejs`.

```ejs
<div class="text-center py-12 border-2 border-dashed border-slate-200 rounded-lg bg-slate-50">
  <div class="mx-auto h-12 w-12 text-slate-400">
    <!-- Icon -->
  </div>
  <h3 class="mt-2 text-sm font-semibold text-gray-900"><%= title %></h3>
  <p class="mt-1 text-sm text-gray-500"><%= description %></p>
  <div class="mt-6">
    <a href="<%= actionUrl %>" class="btn btn-primary">
      <svg ... class="-ml-1 mr-2 h-5 w-5" ...></svg>
      <%= actionText %>
    </a>
  </div>
</div>
```

This ensures a consistent, professional, and helpful administrative interface.
