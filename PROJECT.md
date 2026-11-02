# Project: AlfaRespuestas Citas Audit & Hardening

## Architecture
- **Language / Runtime**: Node.js (v22+), SQLite (`node:sqlite` DatabaseSync)
- **Core Modules**:
  - `src/config.js`: System configuration (dates, 15-min slots, anti-ban settings)
  - `src/database.js`: SQLite schema, tables (`appointments`, `phone_mappings`, `chat_states`, `audit_logs`), queries, seed recovery
  - `src/scheduler.js`: Slot availability calculations, slot allocation, calendar helpers
  - `src/whatsapp.js`: Baileys integration, message parsing, conversational state machine, queue & anti-ban typing simulation
  - `src/server.js`: Express REST API (`/api/citas`, `/api/public/agendar`, webhooks)
- **Database Path**: `c:\sistema\AlfaRespuestas\data\alfa_citas.sqlite`
- **Backup Reference**: `c:\sistema\AlfaRespuestas\alfa_citas_backup_20261102_200225_058_gkwb.sqlite`

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | DB Schema & Data Contrast | Compare active DB vs backup, audit tables and verify data integrity | M1 | Survey / R1 |
| 2 | Phone Number & LID Mapping Resolution | Resolve all Baileys `@lid` identifiers in appointments to valid phone numbers in `phone_mappings` | M1 | Survey / R1 |
| 3 | Schedule Collision Reassignment | Reassign Apt #20 (Juan Alberto Chavarría) from 09:00 to 17:00 on 2025-11-04 without losing or deleting any appointment | M1 | Survey / R1 |
| 4 | Seed Recovery Sync Alignment | Update `src/seed-recovery.json` to prevent cold-start restoration of the 09:00 duplicate | M1 | Survey / R1 |
| 5 | Scheduler Nearest Slot Logic | Add `getNearestAvailableSlot(dateId, targetSlot)` in `src/scheduler.js` with minute-distance calculation | M2 | Survey / R2 |
| 6 | Database Partial Unique Index | Add `idx_appointments_unique_active_slot` on `appointments(date, time_slot)` where status != 'cancelada' | M2 | Survey / R2 |
| 7 | Booking Route Concurrency Hardening | Harden `POST /api/public/agendar` and `createAppointment` with transaction isolation and nearest slot fallback | M2 | Survey / R2 |
| 8 | WhatsApp Recovery Collision Prevention | Update `recoverFromHistory` to reallocate colliding slots instead of bypassing `isSlotTaken` | M2 | Survey / R2 |
| 9 | Automated Test Suite 100% Pass | Maintain >=66 passing tests in `npm test` without regressions | M2 | Survey / R2 |
| 10 | Schedule Adjustment Notification Formulations | Prepare personalized update message for reallocated candidate (#20) | M3 | Survey / R3 |
| 11 | Incomplete Registration Reminders Formulations | Formulate reminder messages with Vercel link and WhatsApp action for 19 incomplete candidates | M3 | Survey / R3 |
| 12 | User Prior Confirmation Presentation | Present exhaustive recipient list and verbatim message texts for mandatory user approval | M3 | Survey / R3 |
| 13 | Anti-Ban Sequential WhatsApp Dispatch | Deliver confirmed messages sequentially with `ANTI_BAN` delays, typing simulation, and audit logging | M4 | Survey / R3 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Database Audit, LID Resolution & Duplicate Reassignment | Resolve Apt #20 to 17:00, populate `phone_mappings`, align `seed-recovery.json`, verify 0 collisions | none | DONE |
| M2 | Scheduler Logic & Concurrency Collision Prevention | `src/scheduler.js`, `src/database.js`, `src/server.js`, `src/whatsapp.js`, verify `npm test` | M1 | DONE |
| M3 | Messaging Formulation & User Prior Confirmation | Present exact messages and recipients table to user for confirmation before sending | M1 | DONE |
| M4 | WhatsApp Delivery with Anti-Ban Enforcement | Execute sequential sending under ANTI_BAN upon user confirmation | M2, M3 | IN_PROGRESS |

## Interface Contracts
### Scheduler ↔ Database / Server
- `scheduler.getNearestAvailableSlot(dateId, targetSlot)` -> returns string (e.g. `'17:00'`) or `null`
- `database.createAppointment(appointmentData)` -> throws on duplicate active slot; enforces unique partial index
### Messaging ↔ Anti-Ban
- `whatsappService.enqueueSend(fn)` -> minimum gap 1400ms + jitter
- `whatsappService.simulateHumanTyping(jid, text)` -> composing 1500-3500ms + text length + jitter

## Code Layout
- `src/config.js` -> configuration constants
- `src/database.js` -> database access & schema
- `src/scheduler.js` -> scheduling logic
- `src/server.js` -> HTTP API endpoints
- `src/whatsapp.js` -> Baileys WhatsApp client & conversational flow
- `data/alfa_citas.sqlite` -> active database
