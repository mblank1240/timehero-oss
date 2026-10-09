import { EmployeeForm } from '@/components/employee-form'
import { requirePermission } from '@/lib/authz'
import { db } from '@/lib/db'
import { createEmployee } from '@/lib/employees/actions'
import { can } from '@/lib/permissions'

export const metadata = { title: 'Add employee · TimeHero' }

export default async function NewEmployeePage() {
  const user = await requirePermission('MANAGE_EMPLOYEES')
  const [departments, paySchedules, employeeTypes, accessRoles] = await Promise.all([
    db.department.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    db.paySchedule.findMany({
      where: { isActive: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true, isDefault: true },
    }),
    db.employeeType.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, employmentType: true },
    }),
    can(user, 'MANAGE_ACCESS')
      ? db.accessRole.findMany({
          orderBy: [{ allPermissions: 'desc' }, { name: 'asc' }],
          select: { id: true, name: true },
        })
      : undefined,
  ])

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Add employee</h1>
      <EmployeeForm
        action={createEmployee}
        departments={departments}
        paySchedules={paySchedules}
        employeeTypes={employeeTypes}
        accessRoles={accessRoles}
        isNew
        defaults={{
          payScheduleId: paySchedules.find((s) => s.isDefault)?.id ?? '',
        }}
        submitLabel="Create employee"
      />
    </div>
  )
}
