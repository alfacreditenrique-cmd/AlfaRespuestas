---
type: community
cohesion: 0.67
members: 3
---

# Dynamic Dates Manager

**Cohesion:** 0.67 - moderately connected
**Members:** 3 nodes

## Members
- [[fetchDates()]] - code - public/app.js
- [[handleAddDate()]] - code - public/app.js
- [[openDatesModal()]] - code - public/app.js

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Dynamic_Dates_Manager
SORT file.name ASC
```

## Connections to other communities
- 4 edges to [[_COMMUNITY_Dashboard Table & Stats Renderer]]
- 2 edges to [[_COMMUNITY_WebSocket Live Sync Client]]
- 2 edges to [[_COMMUNITY_CRUD & Notification Actions]]
- 2 edges to [[_COMMUNITY_Appointment Modals & Slot Picker]]

## Top bridge nodes
- [[handleAddDate()]] - degree 5, connects to 4 communities
- [[fetchDates()]] - degree 6, connects to 3 communities
- [[openDatesModal()]] - degree 3, connects to 2 communities