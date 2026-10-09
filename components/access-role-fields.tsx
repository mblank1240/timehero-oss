import { Field } from '@/components/form'
import { PERMISSION_GROUPS, type Permission } from '@/lib/permissions'

/**
 * The fields of an access role, shared by the add form and the edit page.
 * Rendered inside a `ConfigForm`, which carries the field errors.
 */
export function AccessRoleFields({
  defaults,
}: {
  defaults?: { name: string; description: string; permissions: readonly Permission[] }
}) {
  return (
    <>
      <Field label="Name" name="name">
        <input id="name" name="name" required maxLength={60} defaultValue={defaults?.name} className="th-input" />
      </Field>
      <Field label="Description" name="description" hint="Optional. Who this role is for.">
        <input
          id="description"
          name="description"
          maxLength={300}
          defaultValue={defaults?.description}
          className="th-input"
        />
      </Field>
      {PERMISSION_GROUPS.map((group) => (
        <fieldset key={group.label} className="space-y-2">
          <legend className="th-label">{group.label}</legend>
          {Object.entries(group.permissions).map(([permission, info]) => (
            <label key={permission} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="permissions"
                value={permission}
                defaultChecked={defaults?.permissions.includes(permission as Permission)}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>
                {info.label}
                <span className="block text-xs text-muted">{info.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ))}
    </>
  )
}
