---
type: community
cohesion: 0.43
members: 8
---

# Dashboard Table & Stats Renderer

**Cohesion:** 0.43 - moderately connected
**Members:** 8 nodes

## Members
- [[app.js]] - code - public/app.js
- [[escapeHtml()]] - code - public/app.js
- [[formatDisplayPhone()]] - code - public/app.js
- [[formatTime12h()]] - code - public/app.js
- [[renderAppointmentsTable()]] - code - public/app.js
- [[renderDateCards()]] - code - public/app.js
- [[renderDatesTable()]] - code - public/app.js
- [[state]] - code - public/app.js

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Dashboard_Table__Stats_Renderer
SORT file.name ASC
```

## Connections to other communities
- 10 edges to [[_COMMUNITY_Appointment Modals & Slot Picker]]
- 9 edges to [[_COMMUNITY_WebSocket Live Sync Client]]
- 8 edges to [[_COMMUNITY_CRUD & Notification Actions]]
- 4 edges to [[_COMMUNITY_Dynamic Dates Manager]]

## Top bridge nodes
- [[app.js]] - degree 32, connects to 4 communities
- [[renderDatesTable()]] - degree 4, connects to 2 communities
- [[escapeHtml()]] - degree 5, connects to 1 community
- [[renderAppointmentsTable()]] - degree 5, connects to 1 community
- [[formatTime12h()]] - degree 3, connects to 1 community