/**
 * Return dead-lettered events to delivery with a fresh retry budget.
 *
 *   bun run events:requeue --outbox [--event <id>]
 *   bun run events:requeue --consumer <name> [--event <id>]
 *
 * Reads N2F_DATABASE_URL. Fix the cause first (see last_error on the row);
 * a requeued event that still fails is dead-lettered again.
 */
import { parse } from '../src/shared/id/index.js';
import { Database } from '../src/shared/postgres/index.js';
import { Mailbox, Store } from '../src/shared/events/postgres/index.js';
import { SecretString } from '../src/shared/secret/index.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const outbox = process.argv.includes('--outbox');
const consumer = option('consumer');
const eventArgument = option('event');
const url = process.env.N2F_DATABASE_URL;

if (outbox === (consumer !== undefined) || !url) {
  console.error(
    'usage: N2F_DATABASE_URL=... bun run events:requeue (--outbox | --consumer <name>) [--event <id>]',
  );
  process.exit(2);
}
const eventId = eventArgument === undefined ? undefined : parse(eventArgument);
if (eventId && !eventId.ok) {
  console.error(`invalid event id: ${eventArgument}`);
  process.exit(2);
}

const opened = await Database.open({
  url: new SecretString(url),
  maxConnections: 1,
  timeoutMs: 5000,
});
if (!opened.ok) {
  console.error(`database unavailable: ${opened.error.type ?? opened.error.kind}`);
  process.exit(1);
}
const database = opened.value;
const id = eventId?.ok ? eventId.value : undefined;
const requeued = outbox
  ? await new Store(database).requeue(id)
  : await new Mailbox(database).requeue(consumer!, id);
await database.close(5000);

if (!requeued.ok) {
  console.error(`requeue failed: ${requeued.error.type ?? requeued.error.kind}`);
  process.exit(1);
}
console.log(
  `requeued ${requeued.value} dead ${outbox ? 'outbox row(s)' : `delivery(ies) for ${consumer}`}`,
);
