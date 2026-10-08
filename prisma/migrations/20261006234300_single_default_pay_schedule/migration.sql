-- At most one pay schedule may be the default. A partial unique index makes
-- this a database guarantee rather than something the service layer has to
-- remember on every write.
CREATE UNIQUE INDEX "pay_schedules_single_default"
  ON "pay_schedules" (("isDefault"))
  WHERE "isDefault";

-- Carryover and rollover month/day values must be real calendar positions.
ALTER TABLE "carryover_windows"
  ADD CONSTRAINT "carryover_windows_month_day_range" CHECK (
    "earnedFromMonth" BETWEEN 1 AND 12 AND "earnedFromDay" BETWEEN 1 AND 31 AND
    "earnedToMonth"   BETWEEN 1 AND 12 AND "earnedToDay"   BETWEEN 1 AND 31 AND
    "usableUntilMonth" BETWEEN 1 AND 12 AND "usableUntilDay" BETWEEN 1 AND 31
  );

-- A pay period cannot end before it starts.
ALTER TABLE "pay_periods"
  ADD CONSTRAINT "pay_periods_end_after_start" CHECK ("endDate" >= "startDate");
