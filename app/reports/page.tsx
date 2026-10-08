import { redirect } from 'next/navigation'

/** Timesheets first: payroll is the report read most often. */
export default function ReportsPage() {
  redirect('/reports/timesheets')
}
