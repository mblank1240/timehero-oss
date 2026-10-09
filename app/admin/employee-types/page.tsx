import Link from 'next/link'

import { EMPLOYMENT_TYPE_LABELS, EmployeeTypeFields } from '@/components/config-fields'
import { ConfigForm, SubmitButton } from '@/components/form'
import { requirePermission } from '@/lib/authz'
import { db } from '@/lib/db'
import { saveEmployeeType } from '@/lib/employee-types/actions'

export const metadata = { title: 'Employee types · TimeHero' }

export default async function EmployeeTypesPage() {
  await requirePermission('MANAGE_EMPLOYEES')
  const [types, leaveTypes] = await Promise.all([
    db.employeeType.findMany({
      orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        policies: {
          orderBy: [{ leaveType: { sortOrder: 'asc' } }, { leaveType: { name: 'asc' } }],
          select: {
            leaveType: { select: { name: true } },
            leavePolicy: { select: { name: true, isActive: true } },
          },
        },
        _count: { select: { employees: true } },
      },
    }),
    db.leaveType.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        accruableBy: true,
        policies: {
          where: { isActive: true },
          orderBy: { name: 'asc' },
          select: { id: true, name: true, isActive: true },
        },
      },
    }),
  ])

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <div>
        <h1 className="text-2xl font-semibold">Employee types</h1>
        <p className="mt-1 text-sm text-muted">
          A starting profile for new employees: their employment type and a leave policy for each
          leave type. Choosing one when adding an employee fills these in once. After that the
          employee&apos;s policies are their own — editing a type changes nobody already created
          from it.
        </p>
      </div>

      <section className="space-y-3">
        {types.length === 0 ? (
          <p className="text-sm text-muted">None yet.</p>
        ) : (
          <ul className="th-card divide-y divide-border">
            {types.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {t.name}
                    {!t.isActive && <span className="ml-2 text-xs text-danger">· inactive</span>}
                  </div>
                  <div className="text-xs text-muted">
                    {EMPLOYMENT_TYPE_LABELS[t.employmentType]} · {t._count.employees}{' '}
                    {t._count.employees === 1 ? 'employee' : 'employees'}
                  </div>
                  <div className="text-xs text-muted">
                    {t.policies.length === 0
                      ? 'No leave policies'
                      : t.policies
                          .map(
                            (p) =>
                              `${p.leaveType.name}: ${p.leavePolicy.name}${
                                p.leavePolicy.isActive ? '' : ' (retired)'
                              }`,
                          )
                          .join(' · ')}
                  </div>
                </div>
                <Link
                  href={`/admin/employee-types/${t.id}`}
                  className="text-sm text-accent hover:underline"
                >
                  Edit<span className="sr-only"> {t.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-4 border-t border-border pt-8">
        <h2 className="text-lg font-semibold">Add an employee type</h2>
        <ConfigForm action={saveEmployeeType.bind(null, null)} successMessage="Employee type added.">
          <EmployeeTypeFields leaveTypes={leaveTypes} />
          <SubmitButton label="Add employee type" />
        </ConfigForm>
      </section>
    </div>
  )
}
