/**
 * The sample staff `prisma/seed.ts` creates, as the e2e specs sign in. The
 * administrator's address follows SEED_ADMIN_EMAIL, as the seed does.
 */
export const ADMIN = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.test'
export const ADMIN_NAME = 'Morgan Ellis'

/** The sending address the sample data sets when the configuration has none. */
export const MAIL_FROM = 'time@example.test'
