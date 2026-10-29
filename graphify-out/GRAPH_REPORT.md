# Graph Report - src  (2026-10-29)

## Corpus Check
- Corpus is ~20,822 words - fits in a single context window. You may not need a graph.

## Summary
- 114 nodes · 215 edges · 11 communities (10 shown, 1 thin omitted)
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 12 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- WhatsApp Anti-Ban & Pairing Engine
- Express REST API & Public Booking
- Baileys Socket & Session Auth
- SQLite Database & LID Phone Mapping
- Appointment Modals & Slot Picker
- Dashboard Table & Stats Renderer
- WebSocket Live Sync Client
- CRUD & Notification Actions
- Core Utilities
- Interview Quota & Ticket Scheduler
- Dynamic Dates Manager

## God Nodes (most connected - your core abstractions)
1. `WhatsAppService` - 24 edges
2. `setupEventListeners()` - 15 edges
3. `showToast()` - 12 edges
4. `fetchAppointments()` - 10 edges
5. `handleSocketMessage()` - 9 edges
6. `fetchStats()` - 8 edges
7. `fetchDates()` - 6 edges
8. `handleSaveEdit()` - 6 edges
9. `loadSlotsForSelect()` - 6 edges
10. `handleSaveNew()` - 6 edges

## Surprising Connections (you probably didn't know these)
- `startServer()` --calls--> `Portal Web Auto-Agendamiento (/agendar)`  [EXTRACTED]
  server.js → src/public/agendar.html
- `WhatsAppService` --implements--> `Escudo Anti-Bloqueo (Anti-Ban)`  [EXTRACTED]
  whatsapp.js → src/whatsapp.js
- `WhatsAppService` --implements--> `Protector Guerra de Sesiones (Codigo 440/403)`  [EXTRACTED]
  whatsapp.js → src/whatsapp.js
- `WhatsAppService` --implements--> `Vinculacion Codigo 8 Digitos (Pairing Code)`  [EXTRACTED]
  whatsapp.js → src/whatsapp.js

## Import Cycles
- None detected.

## Communities (11 total, 1 thin omitted)

### Community 0 - "WhatsApp Anti-Ban & Pairing Engine"
Cohesion: 0.19
Nodes (4): Escudo Anti-Bloqueo (Anti-Ban), Protector Guerra de Sesiones (Codigo 440/403), Vinculacion Codigo 8 Digitos (Pairing Code), WhatsAppService

### Community 1 - "Express REST API & Public Booking"
Cohesion: 0.08
Nodes (15): Portal Web Auto-Agendamiento (/agendar), app, CONFIG, cors, database, ExcelJS, express, http (+7 more)

### Community 2 - "Baileys Socket & Session Auth"
Cohesion: 0.15
Nodes (9): CONFIG, database, {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  isLidUser,
  Browsers
}, fs, MONTHS_ES, path, pino, QRCode (+1 more)

### Community 3 - "SQLite Database & LID Phone Mapping"
Cohesion: 0.17
Nodes (8): CONFIG, database, { DatabaseSync }, db, dbDir, fs, KNOWN_LID_PHONE_MAPPINGS, path

### Community 4 - "Appointment Modals & Slot Picker"
Cohesion: 0.31
Nodes (9): closeDatesModal(), closeEditModal(), handleSaveEdit(), loadSlotsForSelect(), onEditDateChange(), onNewDateChange(), openEditModal(), openNewModal() (+1 more)

### Community 5 - "Dashboard Table & Stats Renderer"
Cohesion: 0.43
Nodes (7): escapeHtml(), formatDisplayPhone(), formatTime12h(), renderAppointmentsTable(), renderDateCards(), renderDatesTable(), state

### Community 6 - "WebSocket Live Sync Client"
Cohesion: 0.43
Nodes (7): fetchInitialData(), fetchStats(), handleSocketMessage(), initWebSocket(), updateDateDropdowns(), updateStatsUI(), updateWhatsAppUI()

### Community 7 - "CRUD & Notification Actions"
Cohesion: 0.53
Nodes (6): cancelAppointment(), closeNewModal(), fetchAppointments(), handleSaveNew(), resendNotification(), showToast()

### Community 9 - "Interview Quota & Ticket Scheduler"
Cohesion: 0.50
Nodes (3): CONFIG, database, scheduler

### Community 10 - "Dynamic Dates Manager"
Cohesion: 0.67
Nodes (3): fetchDates(), handleAddDate(), openDatesModal()

## Knowledge Gaps
- **4 isolated node(s):** `Escudo Anti-Bloqueo (Anti-Ban)`, `Protector Guerra de Sesiones (Codigo 440/403)`, `Vinculacion Codigo 8 Digitos (Pairing Code)`, `Portal Web Auto-Agendamiento (/agendar)`
  These have ≤1 connection - possible missing edges. (Counts symbols only; 54 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `WhatsAppService` connect `WhatsApp Anti-Ban & Pairing Engine` to `Baileys Socket & Session Auth`?**
  _High betweenness centrality (0.232) - this node is a cross-community bridge._
- **Are the 10 inferred relationships involving `setupEventListeners()` (e.g. with `closeEditModal()` and `onEditDateChange()`) actually correct?**
  _`setupEventListeners()` has 10 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Escudo Anti-Bloqueo (Anti-Ban)`, `Protector Guerra de Sesiones (Codigo 440/403)`, `Vinculacion Codigo 8 Digitos (Pairing Code)` to the rest of the system?**
  _4 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Express REST API & Public Booking` be split into smaller, more focused modules?**
  _Cohesion score 0.08333333333333333 - nodes in this community are weakly interconnected._
- **Why does `setupEventListeners()` connect `Appointment Modals & Slot Picker` to `Dynamic Dates Manager`, `Dashboard Table & Stats Renderer`, `WebSocket Live Sync Client`, `CRUD & Notification Actions`?**
  _High betweenness centrality (0.006) - this node is a cross-community bridge._