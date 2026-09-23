/**
 * Poll `read` until `done` accepts its value or the timeout passes, then
 * return the last value. Event delivery is asynchronous in every storage mode,
 * so tests observe its effects by polling rather than immediately.
 */
export async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!done(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = await read();
  }
  return last;
}
