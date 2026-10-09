-- Employee types: a starting profile (employment type and a leave policy per
-- leave type) an administrator picks when creating an employee. Two new tables
-- and a nullable column on employees, so safe for the release before it, which
-- never reads or writes them.

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "employeeTypeId" TEXT;

-- CreateTable
CREATE TABLE "employee_types" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "employmentType" "EmploymentType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_type_policies" (
    "id" TEXT NOT NULL,
    "employeeTypeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "leavePolicyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_type_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employee_types_name_key" ON "employee_types"("name");

-- CreateIndex
CREATE INDEX "employee_type_policies_leaveTypeId_idx" ON "employee_type_policies"("leaveTypeId");

-- CreateIndex
CREATE INDEX "employee_type_policies_leavePolicyId_idx" ON "employee_type_policies"("leavePolicyId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_type_policies_employeeTypeId_leaveTypeId_key" ON "employee_type_policies"("employeeTypeId", "leaveTypeId");

-- CreateIndex
CREATE INDEX "employees_employeeTypeId_idx" ON "employees"("employeeTypeId");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_employeeTypeId_fkey" FOREIGN KEY ("employeeTypeId") REFERENCES "employee_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_type_policies" ADD CONSTRAINT "employee_type_policies_employeeTypeId_fkey" FOREIGN KEY ("employeeTypeId") REFERENCES "employee_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_type_policies" ADD CONSTRAINT "employee_type_policies_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_type_policies" ADD CONSTRAINT "employee_type_policies_leavePolicyId_fkey" FOREIGN KEY ("leavePolicyId") REFERENCES "leave_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
