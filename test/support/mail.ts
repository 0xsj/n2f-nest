/**
 * Reading the development mailbox (`GET /dev/mail`, capture transport). Sign-up
 * no longer returns anything that proves mailbox ownership; tests read the
 * verification link from the message instead.
 */
export type Verification = Readonly<{ challengeId: string; token: string }>;

/**
 * The challenge and token in a verification message's link: the message
 * itself, or the newest one carrying a link in a mailbox listing.
 */
export function verificationFrom(
  source: { text: string } | ReadonlyArray<{ text: string }> | undefined,
): Verification {
  const message = Array.isArray(source)
    ? source.find((candidate) => /\/verify\?/.test(candidate.text))
    : (source as { text: string } | undefined);
  const link = message?.text.match(/\/verify\?(\S+)/)?.[1];
  if (!link) throw new Error('no verification link in the latest message');
  const query = new URLSearchParams(link);
  const challengeId = query.get('challenge');
  const token = query.get('token');
  if (!challengeId || !token) throw new Error('verification link is incomplete');
  return { challengeId, token };
}

/** The dev mailbox path for `email`. */
export const mailbox = (email: string) => `/dev/mail?to=${encodeURIComponent(email)}`;
