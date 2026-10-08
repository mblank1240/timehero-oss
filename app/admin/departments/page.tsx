import { DepartmentForm } from '@/components/department-form'
import { db } from '@/lib/db'

export const metadata = { title: 'Departments · TimeHero' }

export default async function DepartmentsPage() {
  const departments = await db.department.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      _count: { select: { employees: true } },
    },
  })

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <h1 className="text-2xl font-semibold">Departments</h1>

      <ul className="th-card divide-y divide-border">
        {departments.map((d) => (
          <li key={d.id} className="flex items-center justify-between px-4 py-3 text-sm">
            <span className="font-medium">{d.name}</span>
            <span className="text-muted">
              {d._count.employees} {d._count.employees === 1 ? 'employee' : 'employees'}
            </span>
          </li>
        ))}
        {departments.length === 0 && (
          <li className="px-4 py-3 text-sm text-muted">No departments yet.</li>
        )}
      </ul>

      <section className="space-y-3 border-t border-border pt-8">
        <h2 className="text-lg font-semibold">Add a department</h2>
        <DepartmentForm />
      </section>
    </div>
  )
}
