-- CreateEnum
CREATE TYPE "DirectoryProvider" AS ENUM ('MICROSOFT', 'GOOGLE');

-- CreateTable
CREATE TABLE "identities" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "provider" "DirectoryProvider" NOT NULL,
    "subject" TEXT NOT NULL,
    "tenant" TEXT,
    "email" TEXT,
    "directoryAccountEnabled" BOOLEAN,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ,

    CONSTRAINT "identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "directory_connections" (
    "id" TEXT NOT NULL,
    "provider" "DirectoryProvider" NOT NULL,
    "tenantId" TEXT NOT NULL,
    "domains" TEXT[],
    "autoProvision" BOOLEAN NOT NULL DEFAULT true,
    "connectedById" TEXT,
    "lastSyncAt" TIMESTAMPTZ,
    "lastSyncDetail" JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "directory_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sign_in_link_requests" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "ipAddress" TEXT,
    "employeeId" TEXT,
    "tokenHash" TEXT,
    "expiresAt" TIMESTAMPTZ,
    "usedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sign_in_link_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "identities_employeeId_idx" ON "identities"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "identities_provider_subject_key" ON "identities"("provider", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "directory_connections_provider_key" ON "directory_connections"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "sign_in_link_requests_tokenHash_key" ON "sign_in_link_requests"("tokenHash");

-- CreateIndex
CREATE INDEX "sign_in_link_requests_email_createdAt_idx" ON "sign_in_link_requests"("email", "createdAt");

-- CreateIndex
CREATE INDEX "sign_in_link_requests_ipAddress_createdAt_idx" ON "sign_in_link_requests"("ipAddress", "createdAt");

-- AddForeignKey
ALTER TABLE "identities" ADD CONSTRAINT "identities_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "directory_connections" ADD CONSTRAINT "directory_connections_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sign_in_link_requests" ADD CONSTRAINT "sign_in_link_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- Carry every bound Microsoft account across before the column goes, so
-- nobody has to be matched by email again. The tenant is not recorded on
-- the old column; the next sign-in fills it in.
INSERT INTO "identities" ("id", "employeeId", "provider", "subject", "email", "createdAt")
SELECT 'mig_' || md5("id"), "id", 'MICROSOFT', "entraOid", "email", CURRENT_TIMESTAMP
FROM "employees"
WHERE "entraOid" IS NOT NULL;

DROP INDEX "employees_entraOid_key";
ALTER TABLE "employees" DROP COLUMN "entraOid",
ADD COLUMN     "needsReview" BOOLEAN NOT NULL DEFAULT false;

-- A link was sent exactly when there is a token, and it can only have been
-- used if it was sent.
ALTER TABLE "sign_in_link_requests"
  ADD CONSTRAINT "sign_in_link_requests_token_complete" CHECK (
    ("tokenHash" IS NULL) = ("expiresAt" IS NULL)
    AND ("tokenHash" IS NULL) = ("employeeId" IS NULL)
    AND ("usedAt" IS NULL OR "tokenHash" IS NOT NULL)
  );

-- Only addresses in a registered domain are linked by email or imported; an
-- empty list would quietly link nothing.
ALTER TABLE "directory_connections"
  ADD CONSTRAINT "directory_connections_has_domains" CHECK (cardinality("domains") > 0);
