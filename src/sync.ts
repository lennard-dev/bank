// Fetching from the bank into the local transaction copy, and the guard that
// keeps every bank call inside the PSD2 allowance.
import { config } from "./config.ts";
import { eb, EnableBankingError, type Transaction } from "./enablebanking.ts";
import { Ledger, addDays } from "./ledger.ts";
import { store, type StoredAccount } from "./store.ts";
import { isoDate } from "./data.ts";

const log = (msg: string, extra?: unknown) => console.error(`[sync ${new Date().toISOString()}] ${msg}`, extra ?? "");

export class BankBlockedError extends Error {
  readonly until: string;
  constructor(account: StoredAccount, until: string) {
    super(
      `The bank is refusing calls for ${account.label ?? account.name ?? account.uid} until ${until} (PSD2 limit on access without the account holder present). ` +
        `No call was made, because calling earlier only extends the block. Answers come from the stored copy until then.`,
    );
    this.until = until;
  }
}

export function ledgerFor(account: StoredAccount, dir?: string): Ledger {
  return new Ledger(account.identification_hash, dir);
}

export function blockedUntil(account: StoredAccount, now = Date.now()): string | undefined {
  return account.blocked_until && Date.parse(account.blocked_until) > now ? account.blocked_until : undefined;
}

/**
 * Every bank call for an account goes through here: it refuses while the bank
 * has blocked the account, and records a new block when the bank answers 429.
 */
export async function bankCall<T>(account: StoredAccount, fn: () => Promise<T>): Promise<T> {
  const until = blockedUntil(account);
  if (until) throw new BankBlockedError(account, until);
  try {
    return await fn();
  } catch (err) {
    if (err instanceof EnableBankingError) {
      log(`bank call failed for ${account.label ?? account.uid}: ${err.status}`, err.body.slice(0, 300));
      if (err.rateLimited) {
        const until = err.retryAfter ?? new Date(Date.now() + 24 * 3_600_000).toISOString();
        store().update((d) => {
          const a = d.accounts[account.uid];
          if (a) a.blocked_until = until;
        });
        throw new BankBlockedError(account, until);
      }
    }
    throw err;
  }
}

/** All pages of a date range, or an error. Never returns a partial result. */
export async function fetchAll(account: StoredAccount, from: string, to: string, maxPages = 200): Promise<Transaction[]> {
  return bankCall(account, async () => {
    const all: Transaction[] = [];
    let key: string | undefined;
    let pages = 0;
    do {
      const page = await eb.getTransactionPage(account.uid, { dateFrom: from, dateTo: to, continuationKey: key });
      all.push(...page.transactions);
      key = page.continuation_key || undefined;
      pages += 1;
      if (key && pages >= maxPages) throw new Error(`More than ${maxPages} pages for ${from} to ${to}; nothing was stored. Try a shorter range.`);
    } while (key);
    return all;
  });
}

/** Oldest day the bank will still return. */
export function earliestFetchable(today = isoDate()): string {
  return addDays(today, -config.syncLookbackDays);
}

/** Store a complete fetch and mark the account as synced. */
export function storeFetch(account: StoredAccount, raw: Transaction[], from: string, to: string) {
  const result = ledgerFor(account).ingest(raw, from, to);
  store().update((d) => {
    const a = d.accounts[account.uid];
    if (!a) return;
    a.last_sync = new Date().toISOString();
    delete a.sync_error;
  });
  return result;
}

/**
 * Bring the stored copy up to date: from a week before the last synced day
 * (banks back-date bookings) or, the first time, as far back as the bank allows.
 */
export async function syncAccount(account: StoredAccount, today = isoDate()) {
  const ledger = ledgerFor(account);
  const floor = earliestFetchable(today);
  const through = ledger.data.bank_through;
  let from = through ? addDays(through, -7) : floor;
  if (from < floor) from = floor;
  try {
    const raw = await fetchAll(account, from, today);
    const result = storeFetch(account, raw, from, today);
    log(`synced ${account.label ?? account.uid}: ${from} to ${today}, ${result.added} booked, ${result.pending} pending`);
    return { from, to: today, ...result };
  } catch (err) {
    store().update((d) => {
      const a = d.accounts[account.uid];
      if (a) a.sync_error = `${new Date().toISOString()}: ${(err as Error).message.slice(0, 300)}`;
    });
    throw err;
  }
}

/** Background pass: sync every account that is due, skipping blocked ones and those a watch already polls. */
export async function runSync(now = Date.now()): Promise<{ synced: string[]; skipped: string[]; errors: string[] }> {
  const out = { synced: [] as string[], skipped: [] as string[], errors: [] as string[] };
  if (!config.syncEnabled) return out;
  const s = store();
  const watched = new Set(s.watches().filter((w) => w.active).map((w) => w.account));
  const dueBefore = now - config.syncIntervalHours * 3_600_000;
  for (const account of s.accounts()) {
    const name = account.label ?? account.name ?? account.uid;
    const session = s.data.sessions[account.session_id];
    if (watched.has(account.uid) || blockedUntil(account, now) || session?.status === "EXPIRED" || (account.last_sync && Date.parse(account.last_sync) > dueBefore)) {
      out.skipped.push(name);
      continue;
    }
    try {
      await syncAccount(account);
      out.synced.push(name);
    } catch (err) {
      out.errors.push(`${name}: ${(err as Error).message}`);
    }
  }
  return out;
}
