---
type: community
cohesion: 0.53
members: 6
---

# CRUD & Notification Actions

**Cohesion:** 0.53 - moderately connected
**Members:** 6 nodes

## Members
- [[cancelAppointment()]] - code - public/app.js
- [[closeNewModal()]] - code - public/app.js
- [[fetchAppointments()]] - code - public/app.js
- [[handleSaveNew()]] - code - public/app.js
- [[resendNotification()]] - code - public/app.js
- [[showToast()]] - code - public/app.js

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/CRUD__Notification_Actions
SORT file.name ASC
```

## Connections to other communities
- 8 edges to [[_COMMUNITY_Dashboard Table & Stats Renderer]]
- 7 edges to [[_COMMUNITY_Appointment Modals & Slot Picker]]
- 5 edges to [[_COMMUNITY_WebSocket Live Sync Client]]
- 2 edges to [[_COMMUNITY_Dynamic Dates Manager]]

## Top bridge nodes
- [[showToast()]] - degree 12, connects to 4 communities
- [[fetchAppointments()]] - degree 10, connects to 3 communities
- [[handleSaveNew()]] - degree 6, connects to 3 communities
- [[cancelAppointment()]] - degree 4, connects to 2 communities
- [[closeNewModal()]] - degree 3, connects to 2 communities