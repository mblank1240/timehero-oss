-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('APPROVAL_WAITING', 'REQUEST_DECIDED', 'TIMESHEET_DUE', 'TIMESHEET_OVERDUE', 'ROLLOVER_SUMMARY');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'DIGEST');

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "approvalDigest" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "org_settings" ADD COLUMN     "approvalEscalateAfterDays" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "approvalEscalateIntervalHours" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "approvalReminderAfterDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "approvalReminderIntervalHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "approverDigestHour" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "mailFromAddress" TEXT,
ADD COLUMN     "notificationTypesEnabled" "NotificationType"[] DEFAULT ARRAY['APPROVAL_WAITING', 'REQUEST_DECIDED', 'TIMESHEET_DUE', 'TIMESHEET_OVERDUE', 'ROLLOVER_SUMMARY']::"NotificationType"[],
ADD COLUMN     "timesheetReminderDaysBeforePeriodEnd" INTEGER NOT NULL DEFAULT 2;

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "readAt" TIMESTAMPTZ,
    "pushStatus" "DeliveryStatus",
    "emailStatus" "DeliveryStatus",
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "employeeId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "push" BOOLEAN NOT NULL,
    "email" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("employeeId","type")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" TIMESTAMPTZ,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_digests" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_digests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_recipientId_createdAt_idx" ON "notifications"("recipientId", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_pushStatus_idx" ON "notifications"("pushStatus");

-- CreateIndex
CREATE INDEX "notifications_emailStatus_idx" ON "notifications"("emailStatus");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_recipientId_key_key" ON "notifications"("recipientId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_employeeId_idx" ON "push_subscriptions"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_digests_employeeId_date_key" ON "notification_digests"("employeeId", "date");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_digests" ADD CONSTRAINT "notification_digests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Escalation intervals and the digest hour have to make sense, or the
-- reminder sweep divides by zero or never fires.
ALTER TABLE "org_settings"
  ADD CONSTRAINT "org_settings_approval_reminders_check" CHECK (
    "approvalReminderAfterDays" >= 0
    AND "approvalReminderIntervalHours" > 0
    AND "approvalEscalateAfterDays" >= 0
    AND "approvalEscalateIntervalHours" > 0
  ),
  ADD CONSTRAINT "org_settings_timesheet_reminder_check" CHECK ("timesheetReminderDaysBeforePeriodEnd" >= 0),
  ADD CONSTRAINT "org_settings_digest_hour_check" CHECK ("approverDigestHour" BETWEEN 0 AND 23);
