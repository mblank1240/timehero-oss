import Link from 'next/link'
import { notFound } from 'next/navigation'

import { EmployeeTypeFields } from '@/components/config-fields'
import { ConfigForm, SubmitButton } from '@/components/form'
import { requireAdmin } from '@/lib/authz'
import { db } from '@/lib/db'
import { saveEmployeeType } from '@/lib/employee-types/actions'

export const metadata = { title: 'Edit employee type · TimeHero' }

export default async function EditEmployeeTypePage({
  params,
}: PageProps<'/admin/employee-types/[id]'>) {
  await requireAdmin()
  const { id } = await params
  const type = await db.employeeType.findUnique({
    where: { id },
    include: { policies: { select: { leaveTypeId: true, leavePolicyId: true } } },
  })
  if (!type) notFound()

  // Keep the type's own choices selectable even if they have since been
  // retired, so saving the form does not silently drop them.
  const chosenTypes = type.policies.map((p) => p.leaveTypeId)
  const chosenPolicies = type.policies.map((p) => p.leavePolicyId)
  const leaveTypes = await db.leaveType.findMany({
    where: { OR: [{ isActive: true }, { id: { in: chosenTypes } }] },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      accruableBy: true,
      policies: {
        where: { OR: [{ isActive: true }, { id: { in: chosenPolicies } }] },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, isActive: true },
      },
    },
  })

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link href="/admin/employee-types" className="text-sm text-muted hover:underline">
          ← Employee types
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Edit {type.name}</h1>
        <p className="mt-1 text-sm text-muted">
          Changes apply to employees created from now on. Anyone already created from this type
          keeps the policies they were given; change theirs on their own record. Untick Active to
          retire the type.
        </p>
      </div>
      <ConfigForm action={saveEmployeeType.bind(null, type.id)} successMessage="Saved.">
        <EmployeeTypeFields
          leaveTypes={leaveTypes}
          defaults={{
            name: type.name,
            employmentType: type.employmentType,
            sortOrder: type.sortOrder,
            isActive: type.isActive,
            policies: Object.fromEntries(type.policies.map((p) => [p.leaveTypeId, p.leavePolicyId])),
          }}
        />
        <SubmitButton label="Save changes" />
      </ConfigForm>
    </div>
  )
}
