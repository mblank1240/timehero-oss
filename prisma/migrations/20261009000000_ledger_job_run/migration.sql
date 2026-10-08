-- Phase 9: ledger entries record the JobRun that wrote them, so Phase 10 can
-- reverse a run. Nullable: entries made by people have no run. Added before
-- production data because it cannot be backfilled.

-- AlterTable
ALTER TABLE "ledger_entries" ADD COLUMN     "jobRunId" TEXT;

-- CreateIndex
CREATE INDEX "ledger_entries_jobRunId_idx" ON "ledger_entries"("jobRunId");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_jobRunId_fkey" FOREIGN KEY ("jobRunId") REFERENCES "job_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

