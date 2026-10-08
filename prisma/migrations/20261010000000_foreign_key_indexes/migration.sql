-- Indexes on three foreign keys that had none: a delete or update of the
-- referenced row (an employee, a leave type) otherwise scans the whole table.
-- Index creation only, so safe for the release before it. The tables are
-- small enough that a plain CREATE INDEX holds its lock for moments.

-- CreateIndex
CREATE INDEX "approval_steps_decidedById_idx" ON "approval_steps"("decidedById");

-- CreateIndex
CREATE INDEX "ledger_entries_createdById_idx" ON "ledger_entries"("createdById");

-- CreateIndex
CREATE INDEX "time_entries_leaveTypeId_idx" ON "time_entries"("leaveTypeId");
