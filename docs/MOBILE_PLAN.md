# Mobile App Plan (1:1 Parity Target)

This document outlines how to build a mobile app that mirrors the current web
experience as closely as possible. The plan prioritizes functional parity,
shared contracts, and a sustainable release process.

## Framework Choice

**Recommended:** React Native + Expo, TypeScript.

**Why:**
- Matches the existing TypeScript/Node stack and allows shared types.
- Fast iteration with Expo (OTA updates, device testing, CI/CD).
- Strong ecosystem for auth, navigation, realtime, and native modules.
- Avoids maintaining separate iOS/Android codebases.

**Alternatives (if needed):**
- Flutter: excellent UI performance, but introduces Dart and less code sharing.
- Native (Swift/Kotlin): best platform-specific polish, highest cost.

## Framework Comparison (Detailed)

**React Native + Expo**
- **Pros:** TypeScript reuse, large ecosystem, fast iteration, OTA updates, strong
  community support, easier hiring.
- **Cons:** Native module edge cases, some UI polish needs extra work.
- **Best for:** Fast parity delivery with existing TS/Node teams.

**Flutter**
- **Pros:** High-performance rendering, consistent UI across platforms, strong
  developer tooling.
- **Cons:** New language (Dart), less direct code sharing with existing TS stack,
  heavier rewrite of UI logic.
- **Best for:** Teams willing to replatform UI for long-term visual control.

**Native (Swift + Kotlin)**
- **Pros:** Best platform integration, top-tier performance and UX.
- **Cons:** Two codebases, higher cost, slower iteration, less code sharing.
- **Best for:** Highly polished consumer apps with platform-specific needs.

**Recommendation:** React Native + Expo for parity, speed, and stack alignment.

## Principles

- **Parity first:** Feature scope mirrors web functionality, not just UX.
- **API-first:** Web and mobile are peers; no mobile-only shortcuts.
- **Security by default:** RBAC, audit trails, and entitlements enforced server-side.
- **Progressive enhancement:** Start with essential flows, then complete parity.

## High-Level Architecture

### Current
- Web: EJS server-rendered pages
- Backend: Node/Express + Prisma + Redis/BullMQ
- Auth: session-based + WebAuthn

### Proposed (Target)
- Backend: same stack, add a versioned API layer
- Clients: web (existing) + mobile (RN/Expo)
- Shared contracts: TypeScript types + Zod (or equivalent) schemas

```
Mobile App (RN/Expo) -> API Gateway (Express) -> Services (Prisma/Redis/Workers)
Web App (EJS/SSR)   -> API Gateway (Express) -> Services (Prisma/Redis/Workers)
```

## Scope and Parity

All web features should have a mobile equivalent, with mobile-specific UI
patterns (cards, lists, stacked flows) instead of dense tables.

### Feature Coverage (Parity Target)
- Auth + MFA + WebAuthn/Passkeys (mobile equivalents)
- RBAC + audit logs + entitlements
- Models registry and configuration
- Matches: creation, queue, status, replay viewing
- Games catalog and rules
- Chat: channels, private/support/system channels, attachments
- Billing: subscription management and invoices
- Admin: user/org management, permissions, API keys
- HR/Careers: postings, applications, reviews
- Settings and notifications

**Mobile UI adaptations:**
- Tables -> cards and detail views
- Multi-column admin pages -> segmented flows
- Complex forms -> step-based flows with save/resume

## Feature Parity Checklist (1:1 Target)

| Area | Web Feature | Mobile Equivalent | Notes |
|---|---|---|---|
| Public | Home | Mobile landing | In-app or external |
| Public | About | About screen | Static content |
| Public | Benchmarks | Benchmarks screen | Charts adapted |
| Public | How it works | How it works screen | Static content |
| Public | Methodology | Methodology screen | Static content |
| Public | Docs | Docs screen | Link out or embed |
| Public | Use cases | Use cases screen | Static content |
| Public | Privacy | Privacy screen | Static content |
| Public | Terms | Terms screen | Static content |
| Public | Careers | Careers list | Public job list |
| Public | Careers detail | Job detail | Public view |
| Public | Careers apply | Apply flow | Step-based form |
| Auth | Login, sessions | Token auth + secure storage | Add device sessions |
| Auth | Sign up | Signup flow | Full validation |
| Auth | Forgot password | Reset request | Email/SMS |
| Auth | Reset password | Reset flow | Token-based |
| Auth | Verify phone | Phone verification | SMS flow |
| Auth | Verify success | Success screen | UX confirmation |
| Auth | MFA (TOTP) | In-app TOTP flow | Use system keychain |
| Auth | Passkeys/WebAuthn | Native passkeys | Platform API support |
| Access | Access request | Request access flow | If gated access |
| Account | Settings | Profile settings | Notifications |
| Account | MFA setup | MFA setup flow | QR and recovery |
| RBAC | Role management | Role management screens | Admin only |
| RBAC | Access approvals | Approvals list | Admin only |
| RBAC | Block lists | Blocks list | Admin only |
| Audit | Audit logging | Audit log viewer | Filters + pagination |
| Models | Model registry | Model list + detail | Full CRUD |
| Models | Provider configs | Provider config UI | Secrets handling |
| Matches | Create match | Match creation flow | Same rules/inputs |
| Matches | Match list | Match list | Filters + search |
| Matches | Match detail | Match detail | Actions/metadata |
| Matches | Match queue | Queue list + status | Realtime updates |
| Matches | Replay viewer | Mobile replay viewer | Optimized layout |
| Games | Game catalog | Game list + rules | Same configuration |
| Games | Game wizard | Wizard flow | Admin only |
| Chat | Channels | Channel list + threads | Realtime + mentions |
| Chat | Private/support | Private/support chats | RBAC-aware |
| Chat | Admin chat | Admin chat console | Admin only |
| Chat | Admin AI chat | Admin AI chat | Admin only |
| Notifications | Chat settings | Notification prefs | Mute/mentions |
| Billing | Plans + upgrades | Subscription management | Stripe mobile flow |
| Billing | Invoices | Invoice list + detail | Downloads/email |
| Admin | Dashboard | Admin dashboard | KPI cards |
| Admin | Users | User admin screens | CRUD + roles |
| Admin | Models | Admin models list | Admin only |
| Admin | Matches | Admin matches list | Admin only |
| Admin | Analytics | Analytics dashboards | Charts adapted |
| Admin | Content blocks | Content editor | Admin only |
| Admin | Media library | Media manager | Uploads |
| Admin | Plans | Plan manager | Admin only |
| Admin | Entitlements | Entitlement editor | Policy overrides |
| Admin | Entitlements usage | Usage viewer | Charts + filters |
| Admin | API keys | Key management | Create/revoke |
| Admin | Queue | Queue viewer | Job status |
| Admin | Settings | System settings | Admin only |
| HR | HR dashboard | HR overview | Admin only |
| HR | Job postings | Job list + detail | Admin only |
| HR | Job create/edit | Job editor | Admin only |
| HR | Applications | Applicant list + detail | Review flow |
| HR | Application notes | Notes editor | Admin only |
| Investors | Investor home | Investor hub | Static content |
| Investors | Press | Press page | Static content |
| Investors | Financials | Financials page | Static content |
| Investors | Filings | Filings list | Static content |
| Investors | Governance | Governance pages | Static content |
| Investors | FAQ | FAQ page | Static content |
| Investors | Contact | Contact page | Static content |

## API Plan

### API Layer
- Create a versioned API (e.g., `/api/v1`) for all actions currently embedded
  in SSR routes.
- Standardize error shapes, pagination, sorting, and filtering.
- Ensure all endpoints are protected by RBAC and entitlements on the server.

### Contract Strategy
- Define request/response schemas in shared packages (Zod or similar).
- Generate client types from schemas to avoid drift.

## Auth and Security

### Auth Strategy
- Move from session cookies to token-based auth for mobile.
- Support refresh tokens and device sessions.
- Secure storage for tokens on device (Keychain/Keystore).

### MFA and Passkeys
- Support TOTP on mobile.
- WebAuthn/Passkeys via platform-native APIs where possible.
- Provide fallbacks for devices without biometrics.

### Security
- Rate limiting and abuse protections at API layer.
- Audit logging for all privileged actions.
- Strict RBAC and entitlements on all endpoints.

## Realtime and Background Work

### Realtime
- Chat and match updates via WebSocket or SSE.
- Push notifications for match completion, chat mentions, and admin alerts.

### Background
- Sync match updates and notifications via background fetch.
- Local caching for recent matches, chat threads, and settings.

## Data and Storage

- Client cache with a query library (TanStack Query or similar).
- Offline-friendly reads; write operations queued when offline.
- Cache invalidation aligned to server events (match complete, new messages).

## UX and Design System

- Build a mobile-first component library with shared tokens (colors, spacing).
- Establish mobile navigation patterns (tabs + stack).
- Build screen templates for admin vs. user features.
- Ensure accessibility (contrast, touch targets, VoiceOver/TalkBack).

## Testing and QA

- Unit tests for shared domain logic.
- API contract tests (schema validation).
- E2E tests for core flows on iOS and Android.
- Visual regression checks for critical screens.

## Build and Release

- Use Expo EAS for CI builds and app store submissions.
- Feature flags for staged rollouts and parity gaps.
- Monitoring and crash reporting (Sentry or equivalent).

## Migration Strategy

1. **Inventory and parity map**
   - List every web route and map to a mobile screen/flow.
2. **API extraction**
   - Convert SSR actions to API endpoints; add versioning.
3. **Core mobile shell**
   - Navigation, auth, settings, and base UI system.
4. **Feature build-out**
   - Implement features by domain (Matches, Models, Chat, Admin, Billing, HR).
5. **Parity QA**
   - Compare flows and outputs to the web; close gaps.
6. **Release**
   - Limited beta, staged rollout, full launch.

## Timeline (Rough Order)

- Phase 0: Discovery + parity mapping
- Phase 1: API foundation + auth/token work
- Phase 2: Mobile shell + core user flows
- Phase 3: Admin + billing + HR parity
- Phase 4: Realtime + push + performance tuning
- Phase 5: Hardening + release

## Open Questions

- Are any features acceptable as webview (Stripe, HR, long-form admin)?
- Are there compliance requirements (SOC2, HIPAA, data residency)?
- Are offline/low-connectivity scenarios critical?

## Deliverables

- API specification and shared contracts
- Mobile component library and design tokens
- Complete feature parity checklist
- Mobile app codebase + CI/CD pipeline
- Test suite and parity QA report

## Risks and Mitigations

- **Feature density:** Mobile screens can get overcrowded.
  - Mitigation: progressive disclosure and step flows.
- **Auth complexity:** Passkeys/MFA across devices.
  - Mitigation: dedicated auth flows and robust fallback.
- **Realtime scale:** Chat and match updates can be heavy.
  - Mitigation: efficient subscriptions and server throttling.
