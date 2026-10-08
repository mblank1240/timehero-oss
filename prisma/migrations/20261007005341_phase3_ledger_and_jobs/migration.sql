-- CreateEnum
CREATE TYPE "LedgerEntryKind" AS ENUM ('LUMP_GRANT', 'PERIOD_ACCRUAL', 'ROLLOVER_IN', 'FORFEIT', 'USAGE', 'USAGE_REVERSAL', 'COMP_EARNED', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "kind" "LedgerEntryKind" NOT NULL,
    "expiresOn" DATE,
    "periodKey" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "periodKey" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" "JobStatus" NOT NULL DEFAULT 'RUNNING',
    "entriesCreated" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ledger_entries_employeeId_leaveTypeId_effectiveDate_idx" ON "ledger_entries"("employeeId", "leaveTypeId", "effectiveDate");

-- CreateIndex
CREATE INDEX "ledger_entries_leaveTypeId_effectiveDate_idx" ON "ledger_entries"("leaveTypeId", "effectiveDate");

-- CreateIndex
CREATE INDEX "ledger_entries_expiresOn_idx" ON "ledger_entries"("expiresOn");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_employeeId_leaveTypeId_kind_periodKey_key" ON "ledger_entries"("employeeId", "leaveTypeId", "kind", "periodKey");

-- CreateIndex
CREATE INDEX "job_runs_jobName_startedAt_idx" ON "job_runs"("jobName", "startedAt");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Ledger guarantees.
--
-- These are the invariants from CLAUDE.md that are cheap to make the database
-- enforce. The service layer checks them too; a constraint is what makes them
-- true of rows written by a migration, a console session, or a future caller
-- that forgot.
-- ---------------------------------------------------------------------------

-- An ADJUSTMENT is a human overriding the engine. Without a reason the entry
-- is unexplainable the moment its author forgets why.
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_adjustment_needs_note" CHECK (
    "kind" <> 'ADJUSTMENT' OR ("note" IS NOT NULL AND btrim("note") <> '')
  );

-- Sign by kind. Catches the whole family of rollover and usage bugs where a
-- forfeit is written positive and silently doubles someone's balance instead
-- of clearing it. ADJUSTMENT is deliberately unconstrained — a correction has
-- to be able to go either way.
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_sign_matches_kind" CHECK (
    CASE "kind"
      WHEN 'FORFEIT' THEN "minutes" <= 0
      WHEN 'USAGE'   THEN "minutes" <= 0
      WHEN 'ADJUSTMENT' THEN TRUE
      ELSE "minutes" >= 0
    END
  );

-- An expiry date before the grant it belongs to would make the lot
-- unspendable from the moment it was written.
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_expiry_after_effective" CHECK (
    "expiresOn" IS NULL OR "expiresOn" >= "effectiveDate"
  );

-- Rule 4 in CLAUDE.md: comp time is for exempt staff only. The FLSA bars
-- private employers from giving non-exempt employees comp time in lieu of
-- overtime pay, so this is a wage-and-hour liability rather than a bug. It
-- spans two tables, so it needs a trigger rather than a CHECK.
CREATE FUNCTION "ledger_entries_comp_earned_requires_exempt"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."kind" = 'COMP_EARNED' AND NOT EXISTS (
    SELECT 1 FROM "employees"
    WHERE "id" = NEW."employeeId" AND "employmentType" = 'SALARIED_EXEMPT'
  ) THEN
    RAISE EXCEPTION
      'COMP_EARNED is restricted to SALARIED_EXEMPT employees (employee %)',
      NEW."employeeId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_entries_comp_earned_requires_exempt"
  BEFORE INSERT ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "ledger_entries_comp_earned_requires_exempt"();

-- Rule 2: the ledger is append-only. A correction is a new entry, never an
-- edit, because an editable row makes every historical balance unverifiable.
--
-- DELETE is deliberately left alone: the only path to one is the foreign-key
-- cascade from removing an employee outright, which is erasing a record rather
-- than rewriting history. UPDATE has no legitimate caller at all.
CREATE FUNCTION "ledger_entries_are_append_only"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'ledger_entries is append-only; post a correcting entry instead of updating %',
    OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_entries_are_append_only"
  BEFORE UPDATE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "ledger_entries_are_append_only"();
