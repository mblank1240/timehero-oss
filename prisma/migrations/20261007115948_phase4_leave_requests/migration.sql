-- CreateEnum
CREATE TYPE "LeaveRequestStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'DENIED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalStepStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'SKIPPED');

-- AlterTable
ALTER TABLE "org_settings" ADD COLUMN     "workWeekDays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[];

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
    "totalMinutes" INTEGER NOT NULL,
    "note" TEXT,
    "submittedAt" TIMESTAMPTZ,
    "resolvedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_request_days" (
    "id" TEXT NOT NULL,
    "leaveRequestId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,

    CONSTRAINT "leave_request_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_steps" (
    "id" TEXT NOT NULL,
    "leaveRequestId" TEXT,
    "step" INTEGER NOT NULL,
    "approverId" TEXT,
    "status" "ApprovalStepStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMPTZ,
    "comment" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "approval_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leave_requests_employeeId_status_idx" ON "leave_requests"("employeeId", "status");

-- CreateIndex
CREATE INDEX "leave_requests_status_idx" ON "leave_requests"("status");

-- CreateIndex
CREATE INDEX "leave_request_days_date_idx" ON "leave_request_days"("date");

-- CreateIndex
CREATE UNIQUE INDEX "leave_request_days_leaveRequestId_date_key" ON "leave_request_days"("leaveRequestId", "date");

-- CreateIndex
CREATE INDEX "approval_steps_approverId_status_idx" ON "approval_steps"("approverId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "approval_steps_leaveRequestId_step_key" ON "approval_steps"("leaveRequestId", "step");

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_request_days" ADD CONSTRAINT "leave_request_days_leaveRequestId_fkey" FOREIGN KEY ("leaveRequestId") REFERENCES "leave_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_leaveRequestId_fkey" FOREIGN KEY ("leaveRequestId") REFERENCES "leave_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Request guarantees. The service layer checks all of these too; a constraint
-- is what makes them true of rows written by anything else.
-- ---------------------------------------------------------------------------

-- ISO weekdays only, and never null: the request form reads it to choose its
-- defaults, and an array holding 0 or 8 would silently match nothing.
ALTER TABLE "org_settings"
  ADD CONSTRAINT "org_settings_work_week_days_valid" CHECK (
    "workWeekDays" IS NOT NULL AND "workWeekDays" <@ ARRAY[1, 2, 3, 4, 5, 6, 7]
  );

-- A day of leave is a positive number of minutes. Zero would be a day the
-- form should not have sent; negative would credit the balance on approval.
ALTER TABLE "leave_request_days"
  ADD CONSTRAINT "leave_request_days_minutes_positive" CHECK ("minutes" > 0);

ALTER TABLE "leave_requests"
  ADD CONSTRAINT "leave_requests_total_positive" CHECK ("totalMinutes" > 0);

-- A resolved request says when it was resolved; an open one does not.
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "leave_requests_resolved_at_matches_status" CHECK (
    ("status" IN ('APPROVED', 'DENIED', 'CANCELLED')) = ("resolvedAt" IS NOT NULL)
  );

-- Exactly one subject per step. Phases 6 and 7 add overtime logs and
-- timesheets and widen this to num_nonnulls(...) = 1 across all three.
ALTER TABLE "approval_steps"
  ADD CONSTRAINT "approval_steps_has_one_subject" CHECK ("leaveRequestId" IS NOT NULL);

ALTER TABLE "approval_steps"
  ADD CONSTRAINT "approval_steps_step_positive" CHECK ("step" >= 1);

-- A decided step records who decided and when; a pending one has neither.
-- SKIPPED is exempt from needing a decider: a step skipped because the
-- request was resolved before it was reached was decided by nobody.
ALTER TABLE "approval_steps"
  ADD CONSTRAINT "approval_steps_decision_matches_status" CHECK (
    CASE "status"
      WHEN 'PENDING' THEN "decidedAt" IS NULL AND "decidedById" IS NULL
      WHEN 'SKIPPED' THEN "decidedAt" IS NOT NULL
      ELSE "decidedAt" IS NOT NULL
    END
  );

-- Nobody approves their own leave. Self-approval is skipped when the chain is
-- snapshotted; this stops anything else from recording one.
CREATE FUNCTION "approval_steps_not_self_decided"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status" IN ('APPROVED', 'DENIED') AND NEW."leaveRequestId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "leave_requests"
    WHERE "id" = NEW."leaveRequestId" AND "employeeId" = NEW."decidedById"
  ) THEN
    RAISE EXCEPTION
      'an employee may not decide their own leave request (request %)',
      NEW."leaveRequestId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "approval_steps_not_self_decided"
  BEFORE INSERT OR UPDATE ON "approval_steps"
  FOR EACH ROW EXECUTE FUNCTION "approval_steps_not_self_decided"();
