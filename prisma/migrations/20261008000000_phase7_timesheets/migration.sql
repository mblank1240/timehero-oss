-- CreateEnum
CREATE TYPE "TimesheetStatus" AS ENUM ('OPEN', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TimeEntryCategory" AS ENUM ('REGULAR', 'HOLIDAY', 'LEAVE');

-- AlterTable
ALTER TABLE "approval_steps" ADD COLUMN     "timesheetId" TEXT;

-- AlterTable
ALTER TABLE "org_settings" ADD COLUMN     "workweekStartDay" INTEGER NOT NULL DEFAULT 7;

-- CreateTable
CREATE TABLE "timesheets" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "payPeriodId" TEXT NOT NULL,
    "status" "TimesheetStatus" NOT NULL DEFAULT 'OPEN',
    "submittedAt" TIMESTAMPTZ,
    "resolvedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "timesheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_entries" (
    "id" TEXT NOT NULL,
    "timesheetId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "category" "TimeEntryCategory" NOT NULL,
    "note" TEXT,
    "leaveRequestId" TEXT,
    "leaveTypeId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "timesheets_payPeriodId_status_idx" ON "timesheets"("payPeriodId", "status");

-- CreateIndex
CREATE INDEX "timesheets_status_idx" ON "timesheets"("status");

-- CreateIndex
CREATE UNIQUE INDEX "timesheets_employeeId_payPeriodId_key" ON "timesheets"("employeeId", "payPeriodId");

-- CreateIndex
CREATE INDEX "time_entries_timesheetId_date_idx" ON "time_entries"("timesheetId", "date");

-- CreateIndex
CREATE INDEX "time_entries_leaveRequestId_idx" ON "time_entries"("leaveRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "approval_steps_timesheetId_step_key" ON "approval_steps"("timesheetId", "step");

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_timesheetId_fkey" FOREIGN KEY ("timesheetId") REFERENCES "timesheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_payPeriodId_fkey" FOREIGN KEY ("payPeriodId") REFERENCES "pay_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_timesheetId_fkey" FOREIGN KEY ("timesheetId") REFERENCES "timesheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_leaveRequestId_fkey" FOREIGN KEY ("leaveRequestId") REFERENCES "leave_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------
-- Timesheet guarantees. The service layer checks all of these too; a
-- constraint is what makes them true of rows written by anything else.
-- ---------------------------------------------------------------------------

ALTER TABLE "org_settings"
  ADD CONSTRAINT "org_settings_workweek_start_day_iso" CHECK (
    "workweekStartDay" BETWEEN 1 AND 7
  );

-- Anything past OPEN has been submitted at least once; only a decision sets
-- resolvedAt, and opening it again clears it.
ALTER TABLE "timesheets"
  ADD CONSTRAINT "timesheets_submitted_at_matches_status" CHECK (
    "status" = 'OPEN' OR "submittedAt" IS NOT NULL
  );
ALTER TABLE "timesheets"
  ADD CONSTRAINT "timesheets_resolved_at_matches_status" CHECK (
    ("status" IN ('APPROVED', 'REJECTED')) = ("resolvedAt" IS NOT NULL)
  );

ALTER TABLE "time_entries"
  ADD CONSTRAINT "time_entries_minutes_positive" CHECK ("minutes" > 0);

-- A leave row says which request and type it came from; nothing else does.
ALTER TABLE "time_entries"
  ADD CONSTRAINT "time_entries_leave_has_source" CHECK (
    ("category" = 'LEAVE') = ("leaveRequestId" IS NOT NULL AND "leaveTypeId" IS NOT NULL)
  );

-- One worked row and one holiday row a day; one leave row per request a day.
CREATE UNIQUE INDEX "time_entries_one_worked_per_day"
  ON "time_entries"("timesheetId", "date") WHERE "category" = 'REGULAR';
CREATE UNIQUE INDEX "time_entries_one_holiday_per_day"
  ON "time_entries"("timesheetId", "date") WHERE "category" = 'HOLIDAY';
CREATE UNIQUE INDEX "time_entries_one_leave_per_request_day"
  ON "time_entries"("timesheetId", "date", "leaveRequestId") WHERE "category" = 'LEAVE';

-- A submitted or approved timesheet is read-only. Unlocking it is an
-- administrator's decision with a reason, made on the timesheet row; entries
-- can then change again. When the timesheet itself is being deleted (its
-- employee is), the row is already gone and nothing here objects.
CREATE FUNCTION "time_entries_timesheet_editable"() RETURNS TRIGGER AS $$
DECLARE
  sheet TEXT := COALESCE(NEW."timesheetId", OLD."timesheetId");
BEGIN
  IF EXISTS (
    SELECT 1 FROM "timesheets"
    WHERE "id" = sheet AND "status" IN ('SUBMITTED', 'APPROVED')
  ) THEN
    RAISE EXCEPTION 'timesheet % is submitted or approved and cannot be changed', sheet;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."timesheetId" <> OLD."timesheetId" AND EXISTS (
    SELECT 1 FROM "timesheets"
    WHERE "id" = OLD."timesheetId" AND "status" IN ('SUBMITTED', 'APPROVED')
  ) THEN
    RAISE EXCEPTION 'timesheet % is submitted or approved and cannot be changed', OLD."timesheetId";
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "time_entries_timesheet_editable"
  BEFORE INSERT OR UPDATE OR DELETE ON "time_entries"
  FOR EACH ROW EXECUTE FUNCTION "time_entries_timesheet_editable"();

-- Exactly one subject per step, now across all three kinds.
ALTER TABLE "approval_steps" DROP CONSTRAINT "approval_steps_has_one_subject";
ALTER TABLE "approval_steps"
  ADD CONSTRAINT "approval_steps_has_one_subject" CHECK (
    num_nonnulls("leaveRequestId", "overtimeLogId", "timesheetId") = 1
  );

-- Nobody approves their own timesheet either. Replaces the Phase 6 function.
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
  IF NEW."status" IN ('APPROVED', 'DENIED') AND NEW."timesheetId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "timesheets"
    WHERE "id" = NEW."timesheetId" AND "employeeId" = NEW."decidedById"
  ) THEN
    RAISE EXCEPTION
      'an employee may not decide their own timesheet (timesheet %)',
      NEW."timesheetId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
