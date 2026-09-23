import pg from 'pg';

/**
 * Delete the rate-limit buckets of loopback clients. Durable suites all run
 * from 127.0.0.1 against a shared database, so without this a suite inherits
 * the request counts of whatever ran before it in the same window.
 */
export async function resetLoopbackRateLimits(
  databaseUrl = process.env.N2F_DATABASE_URL,
): Promise<void> {
  if (!databaseUrl) return;
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query(
      `DELETE FROM public.n2f_rate_limits
        WHERE bucket_key LIKE '%127.0.0.1%' OR bucket_key LIKE '%:::1%'`,
    );
  } catch (cause) {
    // The table is created by migrations; a first run may reach here earlier.
    if ((cause as { code?: string }).code !== '42P01') throw cause;
  } finally {
    await client.end();
  }
}
