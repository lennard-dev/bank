// Local copy of each account's transactions, kept on the data volume.
//
// Why: PSD2 lets a server read an account only about four times a day while
// the account holder is not present, and most banks return no more than 90
// days. Answering every question live burns that allowance in minutes and
// loses history after three months. Instead the server syncs each account
// about once a day and the tools answer from this copy.
//
// One JSON file per account, keyed by the account's identification hash so a
// renewed consent (new uid) keeps its history. A sync replaces every booked
// transaction inside the fetched date window with what the bank returned, so
// a re-fetched day can never produce duplicates. Pending transactions are
// replaced as a whole on every sync. Imported statement rows (older history)
// live alongside and are never touched by a sync.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import type { Transaction } from "./enablebanking.ts";
import { round2, simplifyTransaction, type SimpleTransaction } from "./data.ts";

export interface LedgerTransaction extends SimpleTransaction {
  /** Stable id: the same booking keeps the same id across syncs. */
  id: string;
  /** The bank's own reference, if any. Some banks make it a position ("2026-10-28.0"), so it is not used as the id. */
  bank_ref?: string;
  /** Order in which the bank listed the booking on its day (0 = first). */
  seq: number;
  source: "bank" | "import";
}

export interface LedgerFile {
  version: 1;
  account_hash: string;
  /** First and last day for which the bank's booked transactions are stored completely. */
  bank_from?: string;
  bank_through?: string;
  last_sync?: string;
  /** First and last day covered by imported statement rows. */
  import_from?: string;
  import_through?: string;
  booked: LedgerTransaction[];
  pending: LedgerTransaction[];
}

const POSITIONAL_REF = /^\d{4}-\d{2}-\d{2}\.\d+$/;

const norm = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Stable id for a booking. Built from what the booking is, not from where the
 * bank happened to list it; `occurrence` separates genuinely identical lines
 * on the same day (two equal card payments at the same shop).
 */
export function stableId(t: SimpleTransaction, bankRef: string | undefined, occurrence: number): string {
  const ref = bankRef && !POSITIONAL_REF.test(bankRef) ? bankRef : "";
  const basis = [t.date, t.amount.toFixed(2), t.currency, ref, norm(t.counterparty), norm(t.description), occurrence].join("|");
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

/** Turns one bank response (in bank order) into ledger rows with stable ids and per-day sequence numbers. */
export function toLedgerRows(raw: Transaction[], source: "bank" | "import" = "bank"): LedgerTransaction[] {
  const seqByDay = new Map<string, number>();
  const seen = new Map<string, number>();
  return raw.map((t) => {
    const s = simplifyTransaction(t);
    const bankRef = t.entry_reference || t.transaction_id || undefined;
    const seq = seqByDay.get(s.date) ?? 0;
    seqByDay.set(s.date, seq + 1);
    const sig = [s.date, s.amount.toFixed(2), bankRef && !POSITIONAL_REF.test(bankRef) ? bankRef : "", norm(s.counterparty), norm(s.description)].join("|");
    const occurrence = seen.get(sig) ?? 0;
    seen.set(sig, occurrence + 1);
    return { ...s, id: stableId(s, bankRef, occurrence), bank_ref: bankRef, seq, source };
  });
}

/** Newest day first; inside a day, the bank's own order. */
export function sortLedger(rows: LedgerTransaction[]): LedgerTransaction[] {
  return [...rows].sort((a, b) => (a.date === b.date ? a.seq - b.seq : a.date < b.date ? 1 : -1));
}

export class Ledger {
  readonly path: string;
  data: LedgerFile;

  constructor(accountHash: string, dir = join(config.dataDir, "transactions")) {
    const safe = createHash("sha256").update(accountHash).digest("hex").slice(0, 32);
    this.path = join(dir, `${safe}.json`);
    this.data = existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, "utf8")) as LedgerFile)
      : { version: 1, account_hash: accountHash, booked: [], pending: [] };
  }

  save(): void {
    mkdirSync(join(this.path, ".."), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /**
   * Store a complete bank fetch for [from, to]. Every booked bank row in that
   * window is replaced; rows outside it and imported rows stay. Only call this
   * with a fetch that followed every continuation key.
   */
  ingest(raw: Transaction[], from: string, to: string, now = new Date()): { added: number; removed: number; pending: number } {
    const rows = toLedgerRows(raw);
    const booked = rows.filter((r) => r.status === "BOOK" && r.date >= from && r.date <= to);
    const pending = rows.filter((r) => r.status !== "BOOK");
    const keep = this.data.booked.filter((r) => r.source !== "bank" || r.date < from || r.date > to);
    const removed = this.data.booked.length - keep.length;
    this.data.booked = sortLedger([...keep, ...booked]);
    this.data.pending = sortLedger(pending);
    // Extend the covered window only when the new fetch touches or overlaps it,
    // so a gap between two windows is never reported as covered.
    const { bank_from, bank_through } = this.data;
    if (!bank_from || !bank_through || to < dayBefore(bank_from) || from > dayAfter(bank_through)) {
      if (!bank_through || to >= bank_through) {
        this.data.bank_from = from;
        this.data.bank_through = to;
      }
    } else {
      this.data.bank_from = from < bank_from ? from : bank_from;
      this.data.bank_through = to > bank_through ? to : bank_through;
    }
    this.data.last_sync = now.toISOString();
    this.save();
    return { added: booked.length, removed, pending: pending.length };
  }

  /**
   * Add statement rows for a period the bank no longer returns. Refuses rows
   * inside the bank-synced window, so the two sources never overlap.
   */
  importRows(rows: LedgerTransaction[]): { added: number; replaced: number } {
    if (!rows.length) return { added: 0, replaced: 0 };
    const dates = rows.map((r) => r.date).sort();
    const from = dates[0]!;
    const to = dates[dates.length - 1]!;
    if (this.data.bank_from && to >= this.data.bank_from) {
      throw new Error(`The statement runs until ${to}, but the bank's own data starts on ${this.data.bank_from}. Import only rows before ${this.data.bank_from}.`);
    }
    const keep = this.data.booked.filter((r) => r.source !== "import" || r.date < from || r.date > to);
    const replaced = this.data.booked.length - keep.length;
    this.data.booked = sortLedger([...keep, ...rows]);
    this.data.import_from = !this.data.import_from || from < this.data.import_from ? from : this.data.import_from;
    this.data.import_through = !this.data.import_through || to > this.data.import_through ? to : this.data.import_through;
    this.save();
    return { added: rows.length, replaced };
  }

  /** Earliest and latest day this ledger can answer for without gaps. */
  coverage(): { from?: string; through?: string; last_sync?: string; bank_from?: string; bank_through?: string; import_from?: string; import_through?: string; gap?: string } {
    const { bank_from, bank_through, import_from, import_through, last_sync } = this.data;
    let from = bank_from;
    let gap: string | undefined;
    if (import_from && import_through) {
      if (!bank_from) from = import_from;
      else if (dayAfter(import_through) >= bank_from) from = import_from < bank_from ? import_from : bank_from;
      else gap = `${dayAfter(import_through)} to ${dayBefore(bank_from)}`;
    }
    return { from, through: bank_through ?? import_through, last_sync, bank_from, bank_through, import_from, import_through, gap };
  }

  covers(from: string, to: string): boolean {
    const c = this.coverage();
    return !!c.from && !!c.through && !c.gap && from >= c.from && to <= c.through;
  }

  query(opts: { from: string; to: string; text?: string; minAmount?: number; maxAmount?: number; direction?: "in" | "out" }): LedgerTransaction[] {
    const needle = opts.text ? norm(opts.text) : undefined;
    return this.data.booked.filter((t) => {
      if (t.date < opts.from || t.date > opts.to) return false;
      if (opts.direction === "in" && t.amount <= 0) return false;
      if (opts.direction === "out" && t.amount >= 0) return false;
      const abs = Math.abs(t.amount);
      if (opts.minAmount !== undefined && abs < opts.minAmount) return false;
      if (opts.maxAmount !== undefined && abs > opts.maxAmount) return false;
      if (needle && !`${norm(t.counterparty)} ${norm(t.description)} ${norm(t.reference)} ${norm(t.counterparty_iban)}`.includes(needle)) return false;
      return true;
    });
  }

  pendingIn(from: string, to: string): LedgerTransaction[] {
    return this.data.pending.filter((t) => t.date >= from && t.date <= to);
  }
}

export function addDays(d: string, n: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
export const dayAfter = (d: string) => addDays(d, 1);
export const dayBefore = (d: string) => addDays(d, -1);

export function totals(rows: SimpleTransaction[]): { total_in: number; total_out: number } {
  let inflow = 0;
  let outflow = 0;
  for (const t of rows) (t.amount > 0 ? (inflow += t.amount) : (outflow += t.amount));
  return { total_in: round2(inflow), total_out: round2(outflow) };
}

// --- Statement import (CSV) ---

const HEADER_ALIASES: Record<"date" | "value_date" | "amount" | "counterparty" | "iban" | "description" | "balance" | "currency" | "reference" | "debit_credit", string[]> = {
  date: ["buchungstag", "buchungsdatum", "booking date", "date", "datum", "ημερομηνία", "ημερομηνια"],
  value_date: ["valutadatum", "valuta", "value date", "wertstellung"],
  amount: ["betrag", "amount", "umsatz", "ποσό", "ποσο"],
  counterparty: ["name zahlungsbeteiligter", "beguenstigter/zahlungspflichtiger", "begünstigter/zahlungspflichtiger", "auftraggeber/empfänger", "counterparty", "name", "payee", "empfänger"],
  iban: ["iban zahlungsbeteiligter", "kontonummer/iban", "iban", "counterparty iban"],
  description: ["verwendungszweck", "description", "purpose", "beschreibung", "περιγραφή", "περιγραφη", "text"],
  balance: ["saldo nach buchung", "saldo", "balance", "υπόλοιπο", "υπολοιπο"],
  currency: ["waehrung", "währung", "currency"],
  reference: ["kundenreferenz", "mandatsreferenz", "end-to-end-referenz", "reference"],
  debit_credit: ["soll/haben", "debit/credit", "s/h"],
};

/** Splits CSV text into rows, honouring quotes. Detects ; or , as separator. */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, "");
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const sep = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && clean[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

/** "1.234,56" / "-1234.56" / "1,234.56" / "12,00 S" → number. */
export function parseAmount(raw: string): number {
  let s = raw.replace(/[€\s ]/g, "").replace(/EUR$/i, "");
  let sign = 1;
  if (/[-−]$/.test(s) || /S$/i.test(s)) { sign = -1; s = s.replace(/[-−SsHh]$/, ""); }
  if (/H$/i.test(s)) s = s.slice(0, -1);
  if (s.startsWith("-") || s.startsWith("−")) { sign = -sign; s = s.slice(1); }
  if (s.startsWith("+")) s = s.slice(1);
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Cannot read amount "${raw}"`);
  return round2(sign * n);
}

/** "28.10.2026" / "28/10/2026" / "2026-10-28" / "28.10.26" → "2026-10-28". */
export function parseDate(raw: string): string {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/);
  if (m) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return `${y}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  }
  throw new Error(`Cannot read date "${raw}"`);
}

/**
 * Reads a bank statement export. Recognises the usual German (GLS, Volksbank,
 * Sparkasse), Greek and English column names; anything else can be named with
 * `columns`. Returns rows in file order.
 */
export function rowsFromCsv(text: string, currency: string, columns: Partial<Record<keyof typeof HEADER_ALIASES, string>> = {}): LedgerTransaction[] {
  const table = parseCsv(text);
  // Some exports put a few lines of account info above the header: take the first row that has a date and an amount column.
  const find = (header: string[], key: keyof typeof HEADER_ALIASES) => {
    const lower = header.map((h) => h.trim().toLowerCase());
    if (columns[key]) return lower.indexOf(columns[key]!.trim().toLowerCase());
    for (const alias of HEADER_ALIASES[key]) {
      const i = lower.indexOf(alias);
      if (i >= 0) return i;
    }
    return -1;
  };
  const headerIndex = table.findIndex((r) => find(r, "date") >= 0 && find(r, "amount") >= 0);
  if (headerIndex < 0) throw new Error("Could not find a header row with a date and an amount column. Pass `columns` to name them.");
  const header = table[headerIndex]!;
  const col = Object.fromEntries((Object.keys(HEADER_ALIASES) as Array<keyof typeof HEADER_ALIASES>).map((k) => [k, find(header, k)])) as Record<keyof typeof HEADER_ALIASES, number>;
  const get = (r: string[], k: keyof typeof HEADER_ALIASES) => (col[k] >= 0 ? (r[col[k]] ?? "").trim() : "");

  const raw: Transaction[] = [];
  for (const r of table.slice(headerIndex + 1)) {
    const dateCell = get(r, "date");
    if (!dateCell) continue;
    let amount = parseAmount(get(r, "amount"));
    const dc = get(r, "debit_credit").toUpperCase();
    if ((dc === "S" || dc === "D" || dc === "DBIT") && amount > 0) amount = -amount;
    const date = parseDate(dateCell);
    const valueCell = get(r, "value_date");
    const balanceCell = get(r, "balance");
    const iban = get(r, "iban");
    const name = get(r, "counterparty");
    raw.push({
      transaction_amount: { amount: Math.abs(amount).toFixed(2), currency: get(r, "currency") || currency },
      credit_debit_indicator: amount < 0 ? "DBIT" : "CRDT",
      status: "BOOK",
      booking_date: date,
      value_date: valueCell ? parseDate(valueCell) : undefined,
      creditor: amount < 0 ? { name } : undefined,
      debtor: amount >= 0 ? { name } : undefined,
      creditor_account: amount < 0 && iban ? { iban } : undefined,
      debtor_account: amount >= 0 && iban ? { iban } : undefined,
      remittance_information: get(r, "description") ? [get(r, "description")] : undefined,
      reference_number: get(r, "reference") || undefined,
      balance_after_transaction: balanceCell ? { amount: String(parseAmount(balanceCell)), currency } : undefined,
    });
  }
  // Exports list newest first or oldest first; per-day order follows the file either way.
  return toLedgerRows(raw, "import");
}
