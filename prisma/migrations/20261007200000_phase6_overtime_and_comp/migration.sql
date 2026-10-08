-- CreateEnum
CREATE TYPE "OvertimeLogStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'CANCELLED');

-- AlterTable
ALTER TABLE "approval_steps" ADD COLUMN     "overtimeLogId" TEXT;

-- AlterTable
ALTER TABLE "org_settings" ADD COLUMN     "compExpiresAfterDays" INTEGER,
ADD COLUMN     "compLeaveTypeId" TEXT;

-- CreateTable
CREATE TABLE "overtime_logs" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "note" TEXT NOT NULL,
    "status" "OvertimeLogStatus" NOT NULL DEFAULT 'PENDING',
    "multiplierBps" INTEGER,
    "earnedMinutes" INTEGER,
    "submittedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "overtime_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "overtime_logs_employeeId_status_idx" ON "overtime_logs"("employeeId", "status");

-- CreateIndex
CREATE INDEX "overtime_logs_status_idx" ON "overtime_logs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "approval_steps_overtimeLogId_step_key" ON "approval_steps"("overtimeLogId", "step");

-- AddForeignKey
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_compLeaveTypeId_fkey" FOREIGN KEY ("compLeaveTypeId") REFERENCES "leave_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_overtimeLogId_fkey" FOREIGN KEY ("overtimeLogId") REFERENCES "overtime_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_logs" ADD CONSTRAINT "overtime_logs_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Overtime guarantees. The service layer checks all of these too; a
-- constraint is what makes them true of rows written by anything else.
-- ---------------------------------------------------------------------------

-- Point an existing database at its comp type, as the seed does for a new one.
UPDATE "org_settings" SET "compLeaveTypeId" = (
  SELECT "id" FROM "leave_types" WHERE "code" = 'COMP' AND "accruableBy" = 'EXEMPT_ONLY'
)
WHERE "compLeaveTypeId" IS NULL;

-- At least a day: an expiry on the day of earning would forfeit time the
-- moment it was banked, and the ledger refuses an expiry before its grant.
ALTER TABLE "org_settings"
  ADD CONSTRAINT "org_settings_comp_expiry_positive" CHECK (
    "compExpiresAfterDays" IS NULL OR "compExpiresAfterDays" >= 1
  );

ALTER TABLE "overtime_logs"
  ADD CONSTRAINT "overtime_logs_minutes_positive" CHECK ("minutes" > 0);

ALTER TABLE "overtime_logs"
  ADD CONSTRAINT "overtime_logs_resolved_at_matches_status" CHECK (
    ("status" IN ('APPROVED', 'DENIED', 'CANCELLED')) = ("resolvedAt" IS NOT NULL)
  );

-- An approved log records what it banked and at what rate; nothing else does.
-- Zero is a real answer: time worked in a closed year outside any carryover
-- window would have been forfeited by that year's rollover.
ALTER TABLE "overtime_logs"
  ADD CONSTRAINT "overtime_logs_earned_matches_status" CHECK (
    ("status" = 'APPROVED') = ("earnedMinutes" IS NOT NULL AND "multiplierBps" IS NOT NULL)
    AND ("earnedMinutes" IS NULL OR "earnedMinutes" >= 0)
  );

-- Exactly one subject per step, now across both kinds. Phase 7 adds
-- timesheets to the list.
ALTER TABLE "approval_steps" DROP CONSTRAINT "approval_steps_has_one_subject";
ALTER TABLE "approval_steps"
  ADD CONSTRAINT "approval_steps_has_one_subject" CHECK (
    num_nonnulls("leaveRequestId", "overtimeLogId") = 1
  );

-- Rule 4 in CLAUDE.md: comp time is for exempt staff only. The ledger already
-- refuses a COMP_EARNED row for anyone else; this refuses the overtime log
-- that would lead to one, when it is written and again when it is approved —
-- an employee can move from salaried to hourly while a log is pending.
CREATE FUNCTION "overtime_logs_require_exempt"() RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR (NEW."status" = 'APPROVED' AND OLD."status" <> 'APPROVED'))
    AND NOT EXISTS (
      SELECT 1 FROM "employees"
      WHERE "id" = NEW."employeeId" AND "employmentType" = 'SALARIED_EXEMPT'
    )
  THEN
    RAISE EXCEPTION
      'overtime logs are restricted to SALARIED_EXEMPT employees (employee %)',
      NEW."employeeId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "overtime_logs_require_exempt"
  BEFORE INSERT OR UPDATE ON "overtime_logs"
  FOR EACH ROW EXECUTE FUNCTION "overtime_logs_require_exempt"();

-- Nobody approves their own overtime either. Replaces the Phase 4 function,
-- which looked at leave requests only.
CREATE OR REPLACE FUNCTION "approval_steps_not_self_decided"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status" IN ('APPROVED', 'DENIED') AND NEW."leaveRequestId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "leave_requests"
    WHERE "id" = NEW."leaveRequestId" AND "employeeId" = NEW."decidedById"
  ) THEN
    RAISE EXCEPTION
      'an employee may not decide their own leave request (request %)',
      NEW."leaveRequestId";
  END IF;
  IF NEW."status" IN ('APPROVED', 'DENIED') AND NEW."overtimeLogId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "overtime_logs"
    WHERE "id" = NEW."overtimeLogId" AND "employeeId" = NEW."decidedById"
  ) THEN
    RAISE EXCEPTION
      'an employee may not decide their own overtime log (log %)',
      NEW."overtimeLogId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
