# Appointment list

`GET /me/appointments` returns the authenticated business’s appointments in start-time order (ties by ID), including all states. Optional `clientId` filters by client. `from` and `to` accept instants with an offset; by default they filter appointment **starts** (`start >= from`, `start < to`). Either bound may be omitted.
