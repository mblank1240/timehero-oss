/**
 * The rules for putting an employee on a leave policy, as pure functions:
 * who may hold a leave type at all, and whether two assignments' dates
 * collide. Assigning a policy by hand, starting a new hire on an employee
 * type's policies and the import all ask the same two questions here.
 *
 * Pure — no database.
 */

export type AccruableBy = 'ALL' | 'HOURLY_ONLY' | 'EXEMPT_ONLY'
export type EmploymentType = 'HOURLY' | 'SALARIED_EXEMPT'

/**
 * Rule 4 in CLAUDE.md in its general form. `EXEMPT_ONLY` exists because the
 * FLSA bars private employers from giving non-exempt staff comp time in lieu
 * of overtime pay; `HOURLY_ONLY` is its mirror for anything the church ever
 * decides only hourly staff receive.
 */
export function accruableBy(basis: AccruableBy, employmentType: EmploymentType): boolean {
  switch (basis) {
    case 'ALL':
      return true
    case 'HOURLY_ONLY':
      return employmentType === 'HOURLY'
    case 'EXEMPT_ONLY':
      return employmentType === 'SALARIED_EXEMPT'
  }
}

export type DateRange = { effectiveFrom: Date; effectiveTo: Date | null }

/**
 * Whether `range` shares a day with any of `others`. An employee may hold only
 * one policy per leave type on a given day, which the database cannot
 * express, so whoever writes an assignment checks it here first. An open end
 * runs forever; both ends are inclusive.
 */
export function overlapsAny(range: DateRange, others: readonly DateRange[]): boolean {
  return others.some((other) => {
    const startsBeforeOtherEnds = !other.effectiveTo || range.effectiveFrom <= other.effectiveTo
    const endsAfterOtherStarts = !range.effectiveTo || range.effectiveTo >= other.effectiveFrom
    return startsBeforeOtherEnds && endsAfterOtherStarts
  })
}
