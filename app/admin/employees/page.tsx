import Link from 'next/link'

import { requireAdmin } from '@/lib/authz'
import { db } from '@/lib/db'
import { ROLE_LABEL } from '@/lib/employees/schema'

export const metadata = { title: 'Employees · TimeHero' }

export default async function EmployeesPage() {
  await requireAdmin()
  const employees = await db.employee.findMany({
    orderBy: [{ isActive: 'desc' }, { lastName: 'asc' }, { firstName: 'asc' }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      role: true,
      employmentType: true,
      isActive: true,
      needsReview: true,
      _count: {
        select: {
          identities: true,
          signInLinks: { where: { usedAt: { not: null } } },
        },
      },
      department: { select: { name: true } },
      employeeType: { select: { name: true } },
    },
  })

  const active = employees.filter((e) => e.isActive).length

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Employees</h1>
          <p className="mt-1 text-sm text-muted">
            {active} active of {employees.length} total
          </p>
        </div>
        <Link href="/admin/employees/new" className="th-btn">
          Add employee
        </Link>
      </div>

      <div className="th-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Department</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Pay basis</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id} className="border-b border-border last:border-0">
                <td className="px-4 py-3">
                  <Link
                    href={`/admin/employees/${e.id}`}
                    className="font-medium text-accent hover:underline"
                  >
                    {e.firstName} {e.lastName}
                  </Link>
                  <div className="text-xs text-muted">{e.email}</div>
                </td>
                <td className="px-4 py-3 text-muted">{e.department?.name ?? '—'}</td>
                <td className="px-4 py-3 text-muted">{e.employeeType?.name ?? '—'}</td>
                <td className="px-4 py-3 text-muted">
                  {e.employmentType === 'HOURLY' ? 'Hourly' : 'Salaried'}
                </td>
                <td className="px-4 py-3 text-muted">{ROLE_LABEL[e.role]}</td>
                <td className="px-4 py-3">
                  {e.needsReview && (
                    <span className="mr-2 rounded-full border border-accent/40 px-2 py-0.5 text-xs font-medium text-accent">
                      Needs review
                    </span>
                  )}
                  {e.isActive ? (
                    <span className="text-muted">
                      {e._count.identities + e._count.signInLinks > 0
                        ? 'Active'
                        : 'Active · never signed in'}
                    </span>
                  ) : (
                    <span className="text-danger">Inactive</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {employees.length === 0 && (
        <p className="text-sm text-muted">No employees yet. Add the first one to get started.</p>
      )}
    </div>
  )
}
