/**
 * The filter bar the reports share: a plain GET form, so a filtered report is
 * a link that can be bookmarked or sent, and the download links beside it
 * carry the same filters.
 */

const iso = (date: Date) => date.toISOString().slice(0, 10)

export function RangeFilters({
  range,
  leaveTypes,
  leaveTypeId,
  downloads,
}: {
  range: { from: Date; to: Date }
  leaveTypes: readonly { id: string; name: string }[]
  leaveTypeId: string | null
  downloads: readonly { href: string; label: string }[]
}) {
  return (
    <form className="flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="from" className="th-label">
          From
        </label>
        <input id="from" name="from" type="date" defaultValue={iso(range.from)} className="th-input" />
      </div>
      <div>
        <label htmlFor="to" className="th-label">
          To
        </label>
        <input id="to" name="to" type="date" defaultValue={iso(range.to)} className="th-input" />
      </div>
      <div>
        <label htmlFor="type" className="th-label">
          Leave type
        </label>
        <select id="type" name="type" defaultValue={leaveTypeId ?? ''} className="th-input">
          <option value="">All types</option>
          {leaveTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="th-btn-secondary">
        Show
      </button>
      <Downloads links={downloads} />
    </form>
  )
}

export function Downloads({ links }: { links: readonly { href: string; label: string }[] }) {
  return (
    <>
      {links.map((d) => (
        <a key={d.href} href={d.href} className="th-btn-secondary" download>
          {d.label}
        </a>
      ))}
    </>
  )
}
