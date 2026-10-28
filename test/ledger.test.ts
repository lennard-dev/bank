import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, parseAmount, parseDate, rowsFromCsv, sortLedger, toLedgerRows } from "../src/ledger.ts";
import { EnableBankingError, type Transaction } from "../src/enablebanking.ts";

const tx = (date: string, amount: number, text: string, ref?: string, status = "BOOK"): Transaction => ({
  entry_reference: ref,
  transaction_amount: { amount: Math.abs(amount).toFixed(2), currency: "EUR" },
  credit_debit_indicator: amount < 0 ? "DBIT" : "CRDT",
  status,
  booking_date: date,
  creditor: amount < 0 ? { name: text } : undefined,
  debtor: amount >= 0 ? { name: text } : undefined,
  remittance_information: [`${text} payment`],
});

const dir = () => mkdtempSync(join(tmpdir(), "ledger-"));

test("ids survive a bank that numbers bookings by position", () => {
  // GLS style: entry_reference is "<date>.<position>", and a new booking shifts the positions.
  const first = toLedgerRows([tx("2026-10-23", -1867.58, "Earth Positive", "2026-10-23.0"), tx("2026-10-23", 24.15, "STRIPE", "2026-10-23.1")]);
  const second = toLedgerRows([
    tx("2026-10-23", 100, "New donor", "2026-10-23.0"),
    tx("2026-10-23", -1867.58, "Earth Positive", "2026-10-23.1"),
    tx("2026-10-23", 24.15, "STRIPE", "2026-10-23.2"),
  ]);
  assert.equal(first[0]!.id, second[1]!.id);
  assert.equal(first[1]!.id, second[2]!.id);
});

test("identical bookings on one day keep separate ids", () => {
  const rows = toLedgerRows([tx("2026-10-23", -1867.58, "Earth Positive"), tx("2026-10-23", -1867.58, "Earth Positive")]);
  assert.notEqual(rows[0]!.id, rows[1]!.id);
});

test("a re-fetched window replaces its days instead of adding duplicates", () => {
  const l = new Ledger("acct", dir());
  l.ingest([tx("2026-10-01", -10, "A"), tx("2026-10-05", -20, "B"), tx("2026-10-09", -30, "C")], "2026-10-01", "2026-10-09");
  // Second sync overlaps from the 5th; B was corrected by the bank, D is new.
  l.ingest([tx("2026-10-05", -21, "B"), tx("2026-10-09", -30, "C"), tx("2026-10-12", -40, "D")], "2026-10-05", "2026-10-12");
  const amounts = l.data.booked.map((t) => t.amount).sort((a, b) => a - b);
  assert.deepEqual(amounts, [-40, -30, -21, -10]);
  assert.deepEqual([l.data.bank_from, l.data.bank_through], ["2026-10-01", "2026-10-12"]);
  assert.ok(l.covers("2026-10-02", "2026-10-12"));
  assert.ok(!l.covers("2026-09-30", "2026-10-12"));
});

test("pending items are kept apart, replaced on every sync and filtered by date", () => {
  const l = new Ledger("acct", dir());
  l.ingest([tx("2026-10-26", 6.9, "LIDL", undefined, "PDNG"), tx("2026-10-20", -5, "Copy")], "2026-10-01", "2026-10-28");
  assert.equal(l.data.pending.length, 1);
  assert.equal(l.pendingIn("2026-01-01", "2026-01-31").length, 0, "a pending item does not show up in an unrelated month");
  l.ingest([tx("2026-10-20", -5, "Copy")], "2026-10-15", "2026-10-28");
  assert.equal(l.data.pending.length, 0);
});

test("bank order inside a day is kept", () => {
  const rows = sortLedger(toLedgerRows([tx("2026-10-02", -1, "first"), tx("2026-10-02", -2, "second"), tx("2026-10-03", -3, "later")]));
  assert.deepEqual(rows.map((r) => r.amount), [-3, -1, -2]);
});

test("a later window that leaves a gap does not claim the gap as covered", () => {
  const l = new Ledger("acct", dir());
  l.ingest([tx("2026-07-01", -1, "x")], "2026-07-01", "2026-07-31");
  l.ingest([tx("2026-10-01", -1, "y")], "2026-10-01", "2026-10-28");
  assert.deepEqual([l.data.bank_from, l.data.bank_through], ["2026-10-01", "2026-10-28"]);
  assert.equal(l.data.booked.length, 2, "older rows are kept even when not counted as covered");
});

test("GLS CSV export with account lines above the header", () => {
  const csv = [
    '"Kontoinhaber";"Europe Cares e.V."',
    "",
    "Bezeichnung Auftragskonto;IBAN Auftragskonto;Buchungstag;Valutadatum;Name Zahlungsbeteiligter;IBAN Zahlungsbeteiligter;Verwendungszweck;Betrag;Waehrung;Saldo nach Buchung",
    'Konto;DE13;30.07.2026;30.07.2026;"Parea AMKE";GR02;"donation, July";-14.000,00;EUR;145.117,65',
    "Konto;DE13;29.07.2026;29.07.2026;Laurenz Wahl;DE11;Monatliche Spende;30,00;EUR;159.117,65",
  ].join("\n");
  const rows = rowsFromCsv(csv, "EUR");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.date, "2026-07-30");
  assert.equal(rows[0]!.amount, -14000);
  assert.equal(rows[0]!.counterparty, "Parea AMKE");
  assert.equal(rows[0]!.counterparty_iban, "GR02");
  assert.equal(rows[0]!.balance_after, 145117.65);
  assert.equal(rows[1]!.amount, 30);
  assert.equal(rows[0]!.source, "import");
});

test("imports may not overlap the bank-synced window, and re-imports replace", () => {
  const l = new Ledger("acct", dir());
  l.ingest([tx("2026-08-01", -1, "bank")], "2026-07-31", "2026-10-28");
  const older = toLedgerRows([tx("2026-07-15", -5, "old")], "import");
  const overlapping = toLedgerRows([tx("2026-08-02", -5, "late")], "import");
  assert.throws(() => l.importRows(overlapping), /starts on 2026-07-31/);
  l.importRows(older);
  l.importRows(older);
  assert.equal(l.data.booked.filter((t) => t.source === "import").length, 1);
  assert.equal(l.coverage().gap, "2026-07-16 to 2026-07-30");
});

test("amounts and dates in common export formats", () => {
  assert.equal(parseAmount("1.234,56"), 1234.56);
  assert.equal(parseAmount("-1.867,58"), -1867.58);
  assert.equal(parseAmount("1,234.56"), 1234.56);
  assert.equal(parseAmount("12,00 S"), -12);
  assert.equal(parseAmount("12,00-"), -12);
  assert.equal(parseDate("28.10.2026"), "2026-10-28");
  assert.equal(parseDate("28/10/26"), "2026-10-28");
  assert.equal(parseDate("2026-10-28"), "2026-10-28");
});

test("rate limit errors are recognised and carry the bank's retry time", () => {
  const future = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
  const err = new EnableBankingError(429, JSON.stringify({ code: 429, error: "ASPSP_RATE_LIMIT_EXCEEDED", message: `Access is rejected for 24h without user presence. Retry after ${future}` }));
  assert.ok(err.rateLimited);
  assert.ok(!err.consentGone, "a rate limit is not an expired consent");
  assert.equal(err.retryAfter, new Date(future).toISOString());
  assert.equal(new EnableBankingError(422, "Wrong transactions period requested").rateLimited, false);
});
