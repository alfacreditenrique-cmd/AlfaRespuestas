---
type: community
cohesion: 0.31
members: 9
---

# Appointment Modals & Slot Picker

**Cohesion:** 0.31 - loosely connected
**Members:** 9 nodes

## Members
- [[closeDatesModal()]] - code - public/app.js
- [[closeEditModal()]] - code - public/app.js
- [[handleSaveEdit()]] - code - public/app.js
- [[loadSlotsForSelect()]] - code - public/app.js
- [[onEditDateChange()]] - code - public/app.js
- [[onNewDateChange()]] - code - public/app.js
- [[openEditModal()]] - code - public/app.js
- [[openNewModal()]] - code - public/app.js
- [[setupEventListeners()]] - code - public/app.js

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Appointment_Modals__Slot_Picker
SORT file.name ASC
```

## Connections to other communities
- 10 edges to [[_COMMUNITY_Dashboard Table & Stats Renderer]]
- 7 edges to [[_COMMUNITY_CRUD & Notification Actions]]
- 3 edges to [[_COMMUNITY_WebSocket Live Sync Client]]
- 2 edges to [[_COMMUNITY_Dynamic Dates Manager]]

## Top bridge nodes
- [[setupEventListeners()]] - degree 15, connects to 4 communities
- [[handleSaveEdit()]] - degree 6, connects to 3 communities
- [[openEditModal()]] - degree 3, connects to 2 communities
- [[loadSlotsForSelect()]] - degree 6, connects to 1 community
- [[closeEditModal()]] - degree 3, connects to 1 community