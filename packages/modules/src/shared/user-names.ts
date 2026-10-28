// Display names for user ids, for module queries that show who did something.
import type { Kysely } from 'kysely';

/** The client-only users directory, reached by narrow cast: module schemas do not declare it. */
interface UsersLookup {
  readonly usersDirectory: { readonly id: string; readonly name: string };
}

/** Names from the device's user directory; an unknown id is simply absent from the map. */
export async function userNames(
  db: unknown,
  ids: readonly (string | null)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await (db as Pick<Kysely<UsersLookup>, 'selectFrom'>)
    .selectFrom('usersDirectory')
    .select(['id', 'name'])
    .where('id', 'in', wanted)
    .execute();
  return new Map(rows.map((row) => [row.id, row.name]));
}
