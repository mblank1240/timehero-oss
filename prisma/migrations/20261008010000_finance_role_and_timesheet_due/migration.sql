-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'FINANCE';

-- AlterTable
ALTER TABLE "org_settings" ADD COLUMN     "timesheetDueDaysAfterPeriodEnd" INTEGER NOT NULL DEFAULT 3;

-- Due on the period's last day at the earliest; a negative offset would make
-- a timesheet due before the time on it had been worked.
ALTER TABLE "org_settings"
  ADD CONSTRAINT "org_settings_timesheet_due_non_negative" CHECK (
    "timesheetDueDaysAfterPeriodEnd" >= 0
  );
