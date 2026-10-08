import { db } from '@/lib/db'

/**
 * Liveness for App Service's health check: is this instance up and can it
 * reach the database? Nothing about the jobs — an instance is not unhealthy
 * because a cron somewhere stopped, and App Service would replace it for
 * nothing. That is `/api/health/jobs`.
 *
 * Unauthenticated, and says nothing beyond up or down.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`
    return Response.json({ ok: true })
  } catch (error) {
    console.error('Health check: database unreachable', error)
    return Response.json({ ok: false }, { status: 503 })
  }
}
