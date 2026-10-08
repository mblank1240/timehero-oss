-- CreateEnum
CREATE TYPE "PayScheduleType" AS ENUM ('WEEKLY', 'BIWEEKLY', 'SEMI_MONTHLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "AccrualMethod" AS ENUM ('ANNUAL_LUMP', 'PER_PAY_PERIOD');

-- CreateEnum
CREATE TYPE "FirstYearGrant" AS ENUM ('FULL_AFTER_WAITING', 'PRORATE', 'NONE');

-- CreateEnum
CREATE TYPE "AccruableBy" AS ENUM ('ALL', 'HOURLY_ONLY', 'EXEMPT_ONLY');

-- CreateEnum
CREATE TYPE "CapBasis" AS ENUM ('NONE', 'UNLIMITED', 'FIXED_MINUTES', 'EMPLOYEE_DAYS');

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "payScheduleId" TEXT;

-- CreateTable
CREATE TABLE "pay_schedules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PayScheduleType" NOT NULL,
    "anchorDate" DATE NOT NULL,
    "payDateOffsetDays" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pay_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_periods" (
    "id" TEXT NOT NULL,
    "payScheduleId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "payDate" DATE NOT NULL,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pay_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL DEFAULT 480,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_types" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isPaid" BOOLEAN NOT NULL DEFAULT true,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "allowsNegativeBalance" BOOLEAN NOT NULL DEFAULT false,
    "countsTowardRollover" BOOLEAN NOT NULL DEFAULT true,
    "accruableBy" "AccruableBy" NOT NULL DEFAULT 'ALL',
    "colorHex" TEXT NOT NULL DEFAULT '#1d4ed8',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_policies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "method" "AccrualMethod" NOT NULL,
    "annualMinutes" INTEGER NOT NULL,
    "maxBalanceMinutes" INTEGER,
    "waitingPeriodDays" INTEGER NOT NULL DEFAULT 0,
    "firstYearGrant" "FirstYearGrant" NOT NULL DEFAULT 'FULL_AFTER_WAITING',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_leave_policies" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leavePolicyId" TEXT NOT NULL,
    "annualMinutesOverride" INTEGER,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_leave_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rollover_rules" (
    "id" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "capBasis" "CapBasis" NOT NULL DEFAULT 'NONE',
    "capValue" INTEGER NOT NULL DEFAULT 0,
    "carriedExpiresAfterDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rollover_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carryover_windows" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "earnedFromMonth" INTEGER NOT NULL,
    "earnedFromDay" INTEGER NOT NULL,
    "earnedToMonth" INTEGER NOT NULL,
    "earnedToDay" INTEGER NOT NULL,
    "usableUntilMonth" INTEGER NOT NULL,
    "usableUntilDay" INTEGER NOT NULL,
    "usableUntilYearOffset" INTEGER NOT NULL DEFAULT 1,
    "capBasis" "CapBasis" NOT NULL DEFAULT 'UNLIMITED',
    "capValue" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "carryover_windows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pay_schedules_name_key" ON "pay_schedules"("name");

-- CreateIndex
CREATE INDEX "pay_periods_payScheduleId_endDate_idx" ON "pay_periods"("payScheduleId", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "pay_periods_payScheduleId_startDate_key" ON "pay_periods"("payScheduleId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_date_key" ON "holidays"("date");

-- CreateIndex
CREATE UNIQUE INDEX "leave_types_code_key" ON "leave_types"("code");

-- CreateIndex
CREATE INDEX "leave_policies_leaveTypeId_idx" ON "leave_policies"("leaveTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "leave_policies_leaveTypeId_name_key" ON "leave_policies"("leaveTypeId", "name");

-- CreateIndex
CREATE INDEX "employee_leave_policies_employeeId_idx" ON "employee_leave_policies"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_leave_policies_employeeId_leavePolicyId_effectiveF_key" ON "employee_leave_policies"("employeeId", "leavePolicyId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "rollover_rules_leaveTypeId_key" ON "rollover_rules"("leaveTypeId");

-- CreateIndex
CREATE INDEX "carryover_windows_leaveTypeId_idx" ON "carryover_windows"("leaveTypeId");

-- CreateIndex
CREATE INDEX "employees_payScheduleId_idx" ON "employees"("payScheduleId");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_payScheduleId_fkey" FOREIGN KEY ("payScheduleId") REFERENCES "pay_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_periods" ADD CONSTRAINT "pay_periods_payScheduleId_fkey" FOREIGN KEY ("payScheduleId") REFERENCES "pay_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_policies" ADD CONSTRAINT "leave_policies_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_leave_policies" ADD CONSTRAINT "employee_leave_policies_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_leave_policies" ADD CONSTRAINT "employee_leave_policies_leavePolicyId_fkey" FOREIGN KEY ("leavePolicyId") REFERENCES "leave_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rollover_rules" ADD CONSTRAINT "rollover_rules_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "leave_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carryover_windows" ADD CONSTRAINT "carryover_windows_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "leave_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;
