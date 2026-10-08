import Link from 'next/link'

export type FilterChip = {
  label: string
  href: string
  active: boolean
  count?: number
  /** A leave type's color, shown as a dot before the label. */
  colorHex?: string
}

/**
 * A row of links that each narrow a list. Plain links rather than a form, so
 * filtering works without JavaScript and every filtered view is a URL the
 * employee can bookmark or the dashboard can link to.
 */
export function FilterChips({ label, chips }: { label: string; chips: FilterChip[] }) {
  return (
    <nav aria-label={label} className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      {chips.map((chip) => (
        <Link
          key={chip.href}
          href={chip.href}
          aria-current={chip.active ? 'page' : undefined}
          className={`inline-flex items-center rounded-full border px-3 py-1 text-sm transition ${
            chip.active
              ? 'border-accent bg-accent text-accent-contrast'
              : 'border-border bg-surface text-foreground hover:border-accent'
          }`}
        >
          {chip.colorHex && (
            <span
              aria-hidden
              className="mr-1.5 inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: chip.colorHex }}
            />
          )}
          {chip.label}
          {chip.count !== undefined && (
            <span className={`ml-1.5 tabular-nums ${chip.active ? '' : 'text-muted'}`}>
              {chip.count}
            </span>
          )}
        </Link>
      ))}
    </nav>
  )
}
