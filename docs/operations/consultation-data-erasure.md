# Consultation data erasure runbook

This runbook governs privileged privacy or room-deletion work for the forward
PostgreSQL consultation schema. PostgreSQL is not currently a supported runtime
backend; keep this procedure synchronized before enabling it.

Ordinary application roles must not own consultation tables, bypass triggers,
or run this procedure. Require an approved erasure ticket naming the opaque
`room_id`, an authorized database operator, a current backup or recovery point,
and a second-person review. Never copy consultation JSON into the ticket or
operator logs.

For deployments with per-room encryption, crypto-shredding the room key is the
preferred erasure path. Record the key identifier, destruction confirmation,
row counts, and timestamps in the audit ticket without recording plaintext.

When physical row erasure is required, the table owner performs one transaction:

1. `BEGIN`, set a bounded local lock and statement timeout, and lock
   `consultations`, `consultation_events`, and `consultation_affinities` against
   concurrent application writes.
2. Verify the target using only `room_id` and record pre-erasure row counts.
3. Disable `consultation_events_immutable_update` only when redacting retained
   snapshots; replace sensitive `projection_json` and `snapshot_json` fields
   with an approved minimal tombstone, then re-enable the update trigger.
4. For complete room erasure, disable
   `consultation_events_immutable_delete`, delete the room's events, delete its
   affinities, then delete the parent consultations. `ON DELETE RESTRICT`
   deliberately requires this child-first order.
5. Re-enable every disabled trigger before `COMMIT`. Verify zero target rows (or
   only approved tombstones), confirm foreign-key integrity, and record the
   post-erasure counts and transaction identifier in the audit ticket.

If any check fails, `ROLLBACK`; PostgreSQL rolls back the transactional trigger
changes with the data changes. Confirm both immutable triggers are enabled
before returning the application to service. Trigger-bypass or table-owner
rights must never be granted to the application role.
