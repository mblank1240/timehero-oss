/**
 * What each role may do, as plain functions — no session, no database — so
 * they can be tested and used from anywhere. `lib/authz.ts` builds its guards
 * on these.
 */

import type { Role } from '@/lib/employees/schema'

/**
 * Reports — timesheet exports now, the Phase 8 reports later — are read by
 * administrators and by finance. Finance reads and exports; it changes
 * nothing, and every write path still checks for `ADMIN` alone.
 */
export function canReadReports(user: { role: Role }): boolean {
  return user.role === 'ADMIN' || user.role === 'FINANCE'
}
