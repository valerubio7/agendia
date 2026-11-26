# Appointment list

`GET /me/appointments` returns the authenticated business’s appointments in start-time order (ties by ID), including all states. Optional `clientId` filters by client. `from` and `to` accept instants with an offset; by default they filter appointment **starts** (`start >= from`, `start < to`). Either bound may be omitted.

Agenda can pass `overlap=true` with both `from` and `to` (`from < to`). This returns every appointment whose interval intersects `[from, to)`: `start < to` and `end > from`. Appointments that only touch a bound are excluded. Use overlap results for occupancy; when listing appointments by day, group them by their actual start date. The response, authentication and tenant scope are unchanged.
