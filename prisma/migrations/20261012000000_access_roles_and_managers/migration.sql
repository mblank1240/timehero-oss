-- Access roles replace the fixed EMPLOYEE / ADMIN / FINANCE role: an
-- administrator puts permissions together into named roles and gives each
-- person one or none. Existing administrators get the built-in Administrator
-- role and finance staff a Finance role holding the five reports, so nobody's
-- access changes. `employees.role` stays, unread by the new code, because the
-- release before reads it while this runs.
--
-- Also two directory columns for approval chains from the directory manager.
-- Everything here is additive, so safe for the release before.

-- CreateEnum
CREATE TYPE "Permission" AS ENUM ('MANAGE_ACCESS', 'MANAGE_EMPLOYEES', 'VIEW_TIME_RECORDS', 'MANAGE_TIME_RECORDS', 'MANAGE_LEDGER', 'MANAGE_POLICIES', 'MANAGE_DIRECTORY', 'MANAGE_JOBS', 'MANAGE_SETTINGS', 'REPORT_TIMESHEETS', 'REPORT_BALANCES', 'REPORT_LEAVE', 'REPORT_FORFEITURES', 'REPORT_LEDGER');

-- AlterTable
ALTER TABLE "directory_connections" ADD COLUMN     "chainsFromManager" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "accessRoleId" TEXT;

-- AlterTable
ALTER TABLE "identities" ADD COLUMN     "directoryManagerSubject" TEXT;

-- CreateTable
CREATE TABLE "access_roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "permissions" "Permission"[] DEFAULT ARRAY[]::"Permission"[],
    "allPermissions" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_roles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "access_roles_name_key" ON "access_roles"("name");

-- CreateIndex
CREATE INDEX "employees_accessRoleId_idx" ON "employees"("accessRoleId");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_accessRoleId_fkey" FOREIGN KEY ("accessRoleId") REFERENCES "access_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The ids pass the application's cuid check; nothing looks a role up by them.
INSERT INTO "access_roles" ("id", "name", "description", "permissions", "allPermissions", "updatedAt")
VALUES
  ('cbuiltinadministrator', 'Administrator', 'Everything, including permissions added later.', ARRAY[]::"Permission"[], true, CURRENT_TIMESTAMP),
  ('cbuiltinfinance', 'Finance', 'Reads and exports the reports. Changes nothing.',
   ARRAY['REPORT_TIMESHEETS', 'REPORT_BALANCES', 'REPORT_LEAVE', 'REPORT_FORFEITURES', 'REPORT_LEDGER']::"Permission"[], false, CURRENT_TIMESTAMP);

UPDATE "employees" SET "accessRoleId" = 'cbuiltinadministrator' WHERE "role" = 'ADMIN';
UPDATE "employees" SET "accessRoleId" = 'cbuiltinfinance' WHERE "role" = 'FINANCE';
