import { z } from 'zod'

/** Validation for the directory settings. */

const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

export const googleWorkspaceInput = z.object({
  domains: z
    .string()
    .transform((v) => [
      ...new Set(
        v
          .split(/[\s,]+/)
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean),
      ),
    ])
    .pipe(
      z
        .array(z.string().regex(DOMAIN, 'Enter domains such as example.org.'))
        .min(1, 'Enter at least one domain.'),
    ),
})
