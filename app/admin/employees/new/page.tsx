import { EmployeeForm } from '@/components/employee-form'
import { db } from '@/lib/db'
import { createEmployee } from '@/lib/employees/actions'

export const metadata = { title: 'Add employee · TimeHero' }

export default async function NewEmployeePage() {
  const [departments, paySchedules] = await Promise.all([
    db.department.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    db.paySchedule.findMany({
      where: { isActive: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true, isDefault: true },
    }),
  ])

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Add employee</h1>
      <EmployeeForm
        action={createEmployee}
        departments={departments}
        paySchedules={paySchedules}
        defaults={{
          payScheduleId: paySchedules.find((s) => s.isDefault)?.id ?? '',
        }}
        submitLabel="Create employee"
      />
    </div>
  )
}
