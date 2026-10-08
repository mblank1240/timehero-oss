import { toUtcDay } from '@/lib/accrual/dates'
import { intensity, type Heatmap } from '@/lib/history/heatmap'
import { formatLeaveDate } from '@/lib/requests/format'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** Row labels on alternate weekdays, as GitHub does, so they stay legible. */
const WEEKDAY_LABELS: [number, string][] = [
  [1, 'Mon'],
  [3, 'Wed'],
  [5, 'Fri'],
]
const CELL = '0.6875rem'

/**
 * One year of leave as a grid: weeks across, weekdays down, each day shaded
 * in its leave type's color and by how much of the day was taken.
 *
 * The grid is a picture — its accessible name summarises it, and the table
 * beneath it on the history page carries every day as text.
 */
export function LeaveHeatmap({
  heatmap,
  summary,
  types,
  minutesPerDay,
  today,
  show,
}: {
  heatmap: Heatmap
  summary: string
  types: ReadonlyMap<string, { name: string; colorHex: string }>
  minutesPerDay: number
  today: Date
  show: (minutes: number) => string
}) {
  const todayDay = toUtcDay(today)

  return (
    // Right-to-left on the scroller only, so a grid wider than a phone opens
    // scrolled to its end — the recent and upcoming months — as GitHub's does.
    // The grid itself reads left to right as usual.
    <div className="overflow-x-auto pb-1 [direction:rtl]">
      <div className="w-max min-w-full [direction:ltr]">
        <div
          role="img"
          aria-label={summary}
          className="inline-grid text-[0.625rem] leading-none text-muted"
          style={{
            gridTemplateColumns: `auto repeat(${heatmap.weeks.length}, ${CELL})`,
            gridTemplateRows: `auto repeat(7, ${CELL})`,
            gap: '2px',
          }}
        >
          {heatmap.months.map(({ week, month }) => (
            <span
              key={`m${week}`}
              className="pb-1 whitespace-nowrap"
              style={{ gridRow: 1, gridColumn: `${week + 2} / span 3` }}
            >
              {MONTHS[month - 1]}
            </span>
          ))}

          {WEEKDAY_LABELS.map(([weekday, label]) => (
            <span
              key={label}
              className="flex items-center pr-1.5"
              style={{ gridRow: weekday + 2, gridColumn: 1 }}
            >
              {label}
            </span>
          ))}

          {heatmap.weeks.flatMap((week, w) =>
            week.map((cell, weekday) => {
              if (!cell) return null

              const day = toUtcDay(cell.date)
              const top = cell.uses[0]
              const color = top ? types.get(top.leaveTypeId)?.colorHex : undefined
              const scheduled = day > todayDay && cell.minutes > 0
              const title = top
                ? `${formatLeaveDate(cell.date)}: ${cell.uses
                    .map((u) => `${types.get(u.leaveTypeId)?.name ?? 'Leave'} ${show(u.minutes)}`)
                    .join(', ')}${scheduled ? ' (scheduled)' : ''}`
                : formatLeaveDate(cell.date)

              return (
                <span
                  key={cell.iso}
                  title={title}
                  data-date={cell.iso}
                  data-minutes={cell.minutes || undefined}
                  className={`rounded-[2px] ${color ? '' : 'bg-border/70'} ${
                    day === todayDay ? 'ring-1 ring-foreground' : ''
                  }`}
                  style={{
                    gridRow: weekday + 2,
                    gridColumn: w + 2,
                    // Leave still to come is drawn hollow, in its type's color.
                    ...(color && scheduled ? { border: `2px solid ${color}` } : {}),
                    ...(color && !scheduled
                      ? {
                          backgroundColor: color,
                          opacity: 0.35 + 0.65 * intensity(cell.minutes, minutesPerDay),
                        }
                      : {}),
                  }}
                />
              )
            }),
          )}
        </div>
      </div>
    </div>
  )
}
