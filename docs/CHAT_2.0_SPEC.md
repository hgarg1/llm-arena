# Chat 2.0: "God Mode" Admin & Governance Spec

This document outlines the roadmap to transform the Chat Management system into an enterprise-grade, feature-rich platform.

## 1. Core Philosophy
The Chat system is not just a communication tool; it is a **Governance Surface**.
- **Admins** manage the *space* (topology, access, health).
- **Entitlements** dictate the *privilege* (VIP rooms, priority support).
- **RBAC** controls the *oversight* (moderation, analytics).

## 2. Feature Set

### A. "Pulse" Analytics Dashboard (The "Shock" Factor)
Move beyond simple tables. Provide a live operations center.
-   **Volume Heatmaps**: "When is our community most active?" (Chart.js integration).
-   **Engagement Leaders**: Top 5 most active users (potential ambassadors) and channels.
-   **Sentiment Thermometer**: (Planned) AI analysis of channel mood (Healthy vs. Toxic).

### B. Entitlement-Driven Architecture
Channels are treated as **Assets** tied to the Subscription System.
-   **Feature**: "Bind to Plan"
    -   *Admin UI*: Select a Subscription Plan (e.g., "Pro Tier").
    -   *Logic*: When users subscribe to "Pro", they are *automatically* added to the `#pro-lounge` channel.
    -   *Schema*: Leverage existing `entitlement_required` field.
-   **Feature**: "Entitlement Gating"
    -   Access to features like "Image Uploads" or "Voice Notes" within chat can be toggled per channel based on user entitlements.

### C. Advanced Governance (RBAC Integration)
-   **Role-Gated Channels**:
    -   Channels visible ONLY to specific Admin roles (e.g., `#ops-alerts` for `OpsAdmin`).
-   **Moderation Modes**:
    -   **Slow Mode**: Enforce `X` seconds between messages (useful for high-traffic events).
    -   **Announcement Mode**: Only Admins can post; Users can only read (e.g., `#news`).

### D. "Shadow" Moderation Tools
-   **Shadow Banning**:
    -   Mark a user as `shadow_banned`. They can post, but *no one else sees it*.
    -   *Use Case*: Handling trolls without immediate confrontation.
-   **Global Broadcasts**:
    -   Admin can inject a "System Alert" into ALL channels simultaneously (e.g., "Maintenance in 10 mins").

## 3. Database Schema Updates

```prisma
model ChatChannel {
  // ... existing fields
  is_read_only    Boolean @default(false) // For Announcement Channels
  rate_limit      Int     @default(0)     // Seconds between messages per user
  shadow_ban_level Int    @default(0)     // 0=None, 1=Strict (AI filter), 2=Manual Approval
}

model User {
  // ... existing fields
  chat_shadow_banned Boolean @default(false)
  chat_muted_until   DateTime?
}
```

## 4. Admin UI Layout Plan

The `/admin/chat` page will be redesigned into a multi-tab interface:

1.  **Overview**: High-level metrics charts.
2.  **Channels**: Grid view of channels with "Quick Actions" (Lock, Archive, Settings).
3.  **Moderation**: Queue of reported messages and Shadow Ban list.
4.  **Settings**: Global filters (regex keywords) and rate limits.

## 5. Implementation Steps (Immediate)

1.  **Schema Migration**: Add `is_read_only` and `rate_limit` to `ChatChannel`.
2.  **Controller Update**: Implement `updateChannel` to handle these new flags.
3.  **UI Overhaul**: Replace `<table>` with a rich dashboard using `Chart.js` (cdn) and Card components.
4.  **Connect Entitlements**: Add a dropdown in "Edit Channel" to select from `SubscriptionEntitlement` keys.

---
*Generated for LLM Arena Architecture Planning*
