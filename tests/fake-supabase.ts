/**
 * A tiny in-memory stand-in for the Supabase client, for the draw tests.
 *
 * Only the query shapes `lib/draw.ts` (and the one loader it calls) actually
 * use are implemented, so the tests can prove the important behaviour without a
 * Supabase project: a full tournament is drawn once, a duplicate Paystack
 * callback writes nothing, a crashed draw is rolled back, and a racing draw
 * backs off instead of creating a second set of fixtures.
 *
 * It also enforces the real schema's unique index on
 * `groups (tournament_id, group_name)`, which is the draw's last line of
 * defence against duplicated groups.
 *
 * This file is a test helper, not a test: its name deliberately does not end in
 * `.test.ts`, so `npm test` never runs it on its own.
 */

type Row = Record<string, unknown>;

/** The tables the draw touches. */
export interface FakeTables {
  tournaments: Row[];
  registrations: Row[];
  groups: Row[];
  group_members: Row[];
  group_matches: Row[];
  group_standings: Row[];
}

/** A Supabase-shaped error. */
interface FakeError {
  message: string;
  code?: string;
}

/** What a query resolves to. */
interface FakeResult {
  data?: Row[] | Row | null;
  count?: number | null;
  error: FakeError | null;
}

/**
 * The in-memory database plus the test hooks.
 */
export interface FakeDb {
  tables: FakeTables;
  /**
   * Runs before every query — the test's chance to act like another serverless
   * instance (for example, winning the draw's lock first).
   */
  beforeQuery?: (table: string, operation: string) => void;
  /** Make `insert()` into this table fail, to exercise the rollback. */
  failInsertOn?: string | null;
  /** Ever-increasing id counter (see `makeId`). */
  nextId: number;
}

/** Builds an empty database with a tournament and `paidCount` paid players. */
export function createFakeDb(options: {
  paidCount: number;
  maxPlayers?: number;
  status?: string | null;
  tournamentId?: string;
}): FakeDb {
  const tournamentId = options.tournamentId ?? 'tournament-1';

  return {
    nextId: 0,
    tables: {
      tournaments: [
        {
          id: tournamentId,
          title: 'DLS Champions Cup #1',
          status: options.status ?? 'open',
          max_players: options.maxPlayers ?? 8,
        },
      ],
      registrations: Array.from({ length: options.paidCount }, (_, index) => ({
        id: `player-${index + 1}`,
        tournament_id: tournamentId,
        player_name: `Player ${index + 1}`,
        phone_number: `02400000${index + 1}`,
        momo_number: `02400000${index + 1}`,
        dls_team_name: `Team ${index + 1}`,
        paystack_reference: `DLS-REF-${index + 1}`,
        payment_status: 'paid',
        created_at: new Date(index * 1000).toISOString(),
      })),
      groups: [],
      group_members: [],
      group_matches: [],
      group_standings: [],
    },
  };
}

/**
 * Generates a unique id for an inserted row, the way the real tables'
 * `gen_random_uuid()` defaults do. A counter — not the row count — because one
 * insert creates many rows at once.
 */
function makeId(db: FakeDb, table: string): string {
  db.nextId += 1;
  return `${table}-${db.nextId}`;
}

/** Applies one recorded filter to a row. */
function matches(
  row: Row,
  filter: { type: 'eq' | 'in' | 'is'; column: string; value: unknown },
): boolean {
  const value = row[filter.column] ?? null;
  if (filter.type === 'eq') return value === filter.value;
  if (filter.type === 'is') return value === filter.value;
  return Array.isArray(filter.value) && filter.value.includes(value);
}

/**
 * The chainable query builder, mirroring the subset of the Supabase client the
 * draw uses: `select().eq().maybeSingle()`, `insert().select()`, `update()`,
 * `delete()` and `upsert()`.
 */
class FakeQuery implements PromiseLike<FakeResult> {
  private filters: Array<{ type: 'eq' | 'in' | 'is'; column: string; value: unknown }> = [];
  private single = false;
  private countRequested = false;

  constructor(
    private db: FakeDb,
    private table: keyof FakeTables,
    private operation: 'select' | 'insert' | 'update' | 'delete' | 'upsert',
    private payload: Row[] = [],
    private upsertKeys: string[] = [],
  ) {}

  eq(column: string, value: unknown): this {
    this.filters.push({ type: 'eq', column, value });
    return this;
  }

  in(column: string, value: unknown[]): this {
    this.filters.push({ type: 'in', column, value });
    return this;
  }

  is(column: string, value: unknown): this {
    this.filters.push({ type: 'is', column, value });
    return this;
  }

  select(_columns?: string, options?: { count?: string; head?: boolean }): this {
    if (options?.count) this.countRequested = true;
    return this;
  }

  order(): this {
    return this;
  }

  maybeSingle(): this {
    this.single = true;
    return this;
  }

  then<TResult1 = FakeResult, TResult2 = never>(
    onfulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.run().then(onfulfilled, onrejected);
  }

  /** Executes the query against the in-memory rows. */
  private async run(): Promise<FakeResult> {
    this.db.beforeQuery?.(this.table, this.operation);

    const rows = this.db.tables[this.table];
    const matched = rows.filter((row) => this.filters.every((f) => matches(row, f)));

    switch (this.operation) {
      case 'select': {
        const result: FakeResult = {
          data: this.single ? (matched[0] ?? null) : matched.slice(),
          error: null,
        };
        if (this.countRequested) {
          // `{ count: 'exact', head: true }` must not send the rows back.
          result.count = matched.length;
          result.data = null;
        }
        return result;
      }

      case 'insert': {
        if (this.db.failInsertOn === this.table) {
          return { data: null, error: { message: 'insert failed (test)' } };
        }

        // The real tables have unique indexes; `groups` is the one that keeps
        // the draw honest, so it is enforced here too.
        if (this.table === 'groups') {
          const duplicate = this.payload.some((candidate) =>
            rows.some(
              (row) =>
                row.tournament_id === candidate.tournament_id &&
                row.group_name === candidate.group_name,
            ),
          );
          if (duplicate) {
            return {
              data: null,
              error: {
                code: '23505',
                message:
                  'duplicate key value violates unique constraint "groups_unique_name_per_tournament"',
              },
            };
          }
        }

        const inserted = this.payload.map((row) => ({
          id: makeId(this.db, this.table),
          created_at: new Date().toISOString(),
          ...row,
        }));
        rows.push(...inserted);
        return { data: inserted, error: null };
      }

      case 'update': {
        const patch = this.payload[0] ?? {};
        matched.forEach((row) => Object.assign(row, patch));
        return { data: matched.slice(), error: null };
      }

      case 'delete': {
        this.db.tables[this.table] = rows.filter((row) => !matched.includes(row));

        // The schema sets "on delete cascade" from `groups` to the rows that
        // belong to a group, so deleting a half-drawn group must take its
        // members, fixtures and table rows with it.
        if (this.table === 'groups') {
          const removedIds = new Set(matched.map((row) => row.id));
          for (const child of ['group_members', 'group_matches', 'group_standings'] as const) {
            this.db.tables[child] = this.db.tables[child].filter(
              (row) => !removedIds.has(row.group_id),
            );
          }
        }

        return { data: matched.slice(), error: null };
      }

      case 'upsert': {
        for (const candidate of this.payload) {
          const existing = rows.find((row) =>
            this.upsertKeys.every((key) => row[key] === candidate[key]),
          );
          if (existing) Object.assign(existing, candidate);
          else rows.push({ id: makeId(this.db, this.table), ...candidate });
        }
        return { data: null, error: null };
      }
    }
  }
}

/**
 * A Supabase-client-shaped object backed by {@link FakeDb}.
 *
 * @param db The in-memory database.
 * @returns Something `ensureGroupDraw()` accepts as its `client`.
 */
export function createFakeSupabase(db: FakeDb) {
  return {
    from(table: keyof FakeTables) {
      return {
        select: (_columns?: string, options?: { count?: string; head?: boolean }) =>
          new FakeQuery(db, table, 'select').select(_columns, options),
        insert: (rows: Row[] | Row) =>
          new FakeQuery(db, table, 'insert', Array.isArray(rows) ? rows : [rows]),
        update: (patch: Row) => new FakeQuery(db, table, 'update', [patch]),
        delete: () => new FakeQuery(db, table, 'delete'),
        upsert: (rows: Row[], options?: { onConflict?: string }) =>
          new FakeQuery(
            db,
            table,
            'upsert',
            Array.isArray(rows) ? rows : [rows],
            options?.onConflict?.split(',').map((key) => key.trim()) ?? ['id'],
          ),
      };
    },
    // The draw only ever uses `from()`; the cast keeps the real client's type.
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}
