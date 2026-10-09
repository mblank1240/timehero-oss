import { redirect } from 'next/navigation'

import { requireUser } from '@/lib/authz'
import { REPORT_SECTIONS, sectionsFor } from '@/lib/permissions'

/** The first report this person may read: timesheets, for payroll, when they may. */
export default async function ReportsPage() {
  const user = await requireUser()
  redirect(sectionsFor(user, REPORT_SECTIONS)[0]?.href ?? '/')
}
