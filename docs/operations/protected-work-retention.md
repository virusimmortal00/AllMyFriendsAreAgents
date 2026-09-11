# Protected-work retention and recovery

Protected review and research uses `protected-work.json` in the configured data
directory. Schema version 2 applies the following fixed budgets:

| Data | Budget | Behavior at the boundary |
| --- | ---: | --- |
| Hot terminal records | 30 days and 256 records | Oldest or expired complete records move to the archive. |
| Action receipts | 64 per work record | New return retries stop at 62, leaving two slots for stop and terminal recovery. Existing larger version 1 arrays are retained. |
| Live audit detail | 32 events per work record | The preceding hashed event becomes the audit anchor; subsequent hashes continue from it. |
| New-admission ledger | 6 MiB | New protected work fails closed with a capacity error. |
| Active-recovery reserve | 2 MiB beyond admission | Existing work can still stop, acknowledge delivery, or reach a terminal disposition up to the 8 MiB hot-ledger ceiling. |
| Terminal archive | 16 MiB | Oldest detailed entries compact into a cumulative chained checkpoint. |

The byte ceilings cover normalized compact JSON, not filesystem allocation. The
archive has its own budget and therefore does not consume the hot-ledger recovery
reserve. A validated persisted byte counter makes steady-state archive trimming
linear in the entries removed; full archive hashing and byte-account verification
run at startup rather than on every protected-work mutation.

## Lifecycle and verification

Retention runs on version 2 startup and inside the same atomic write as a
protected-work mutation. It never selects a queued, busy, stopping, catching-up,
report-pending, or blocked record. Each archived entry contains the final
normalized record, its retained audit events and optional compacted anchor, plus
a hash that chains it to the previous archived entry. A record that remains in
the detailed archive continues to answer the same idempotent
start or action request after restart.

When detailed archive entries exceed 16 MiB, the oldest entries are folded into
a checkpoint containing their count and last chain hash. The first remaining
entry must name that hash as its predecessor. The checkpoint retains audit-chain
continuity but intentionally ends exact request replay for the compacted entries.
This is the defined deletion boundary; the server never silently evicts receipts
from active work.

On first open, a version 1 file is validated, wrapped in the version 2 structure,
and atomically replaced. Migration itself retains every record and event. Later
maintenance may archive or compact terminal history according to the budgets
above. Invalid records, hashes, anchors, archive links, or checkpoints fail
startup closed.

## Capacity recovery

An admission-capacity error applies only to creation of a new work identity.
Operators should allow active work to finish or explicitly stop/dismiss it; they
must not delete or hand-edit the ledger. Terminal transitions can use the 2 MiB
reserve, and the next successful mutation archives eligible terminal history.
If the hard hot-ledger ceiling is exhausted, preserve the file and investigate
the oversized active records before restarting. Manual truncation breaks audit
verification and is unsupported.
