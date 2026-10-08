import { redirect } from 'next/navigation'

import { requireReportsAccess } from '@/lib/authz'

/** Timesheets first: payroll is the report read most often. */
export default async function ReportsPage() {
  await requireReportsAccess()
  redirect('/reports/timesheets')
}
