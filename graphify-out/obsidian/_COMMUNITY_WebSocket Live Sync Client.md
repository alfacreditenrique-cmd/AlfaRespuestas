---
type: community
cohesion: 0.43
members: 7
---

# WebSocket Live Sync Client

**Cohesion:** 0.43 - moderately connected
**Members:** 7 nodes

## Members
- [[fetchInitialData()]] - code - public/app.js
- [[fetchStats()]] - code - public/app.js
- [[handleSocketMessage()]] - code - public/app.js
- [[initWebSocket()]] - code - public/app.js
- [[updateDateDropdowns()]] - code - public/app.js
- [[updateStatsUI()]] - code - public/app.js
- [[updateWhatsAppUI()]] - code - public/app.js

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/WebSocket_Live_Sync_Client
SORT file.name ASC
```

## Connections to other communities
- 9 edges to [[_COMMUNITY_Dashboard Table & Stats Renderer]]
- 5 edges to [[_COMMUNITY_CRUD & Notification Actions]]
- 3 edges to [[_COMMUNITY_Appointment Modals & Slot Picker]]
- 2 edges to [[_COMMUNITY_Dynamic Dates Manager]]

## Top bridge nodes
- [[fetchStats()]] - degree 8, connects to 4 communities
- [[handleSocketMessage()]] - degree 9, connects to 2 communities
- [[fetchInitialData()]] - degree 5, connects to 2 communities
- [[updateDateDropdowns()]] - degree 4, connects to 2 communities
- [[updateWhatsAppUI()]] - degree 4, connects to 2 communities