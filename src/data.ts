// Shapes the API responses into what an assistant actually needs: signed
// amounts, one counterparty field, one description field, and a booked vs
// available balance instead of a list of ISO balance codes.
import type { Balance, Transaction } from "./enablebanking.ts";
import type { StoredAccount, StoredSession } from "./store.ts";

export interface SimpleTransaction {
  id: string;
  date: string;
  value_date?: string;
  /** Negative = money out. */
  amount: number;
  currency: string;
  counterparty?: string;
  description?: string;
  status: string;
  balance_after?: number;
  merchant_category_code?: string;
  /** IBAN (or other account id) of the other party, when the bank sends it. */
  counterparty_iban?: string;
  /** Payment reference (end-to-end / creditor reference), when the bank sends it. */
  reference?: string;
}

export function simplifyTransaction(t: Transaction): SimpleTransaction {
  const signed = Number(t.transaction_amount.amount) * (t.credit_debit_indicator === "DBIT" ? -1 : 1);
  const counterparty = (t.credit_debit_indicator === "DBIT" ? t.creditor?.name : t.debtor?.name) || undefined;
  const description = [t.remittance_information?.join(" "), t.bank_transaction_code?.description, t.note].find((s) => s && s.trim()) || undefined;
  const other = t.credit_debit_indicator === "DBIT" ? t.creditor_account : t.debtor_account;
  return {
    id: t.entry_reference || t.transaction_id || `${t.booking_date}:${signed}:${counterparty ?? ""}`,
    date: t.booking_date || t.value_date || t.transaction_date || "",
    value_date: t.value_date && t.value_date !== t.booking_date ? t.value_date : undefined,
    amount: round2(signed),
    currency: t.transaction_amount.currency,
    counterparty,
    description: description && description !== counterparty ? description : undefined,
    status: t.status,
    balance_after: t.balance_after_transaction ? round2(Number(t.balance_after_transaction.amount)) : undefined,
    merchant_category_code: t.merchant_category_code,
    counterparty_iban: other?.iban || other?.other?.identification || undefined,
    reference: t.reference_number || undefined,
  };
}

export interface SimpleBalances {
  /** Booked (cleared) balance: CLBD, or ITBD when the bank gives no CLBD. This is the number to use for net worth. */
  booked?: number;
  /** Available to spend, when the bank reports it (XPCD/OTHR "available"). Credit accounts often report the available credit here. */
  available?: number;
  currency?: string;
  reference_date?: string;
  all: Array<{ type: string; name?: string; amount: number; reference_date?: string }>;
}

export function simplifyBalances(balances: Balance[]): SimpleBalances {
  const byType = (types: string[]) => balances.find((b) => types.includes(b.balance_type));
  const booked = byType(["CLBD"]) ?? byType(["ITBD"]) ?? byType(["CLAV"]);
  const available = byType(["XPCD"]) ?? balances.find((b) => /avail/i.test(b.name ?? "") || /avail/i.test(b.balance_type));
  return {
    booked: booked ? round2(Number(booked.balance_amount.amount)) : undefined,
    available: available && available !== booked ? round2(Number(available.balance_amount.amount)) : undefined,
    currency: (booked ?? balances[0])?.balance_amount.currency,
    reference_date: (booked ?? balances[0])?.reference_date,
    all: balances.map((b) => ({ type: b.balance_type, name: b.name, amount: round2(Number(b.balance_amount.amount)), reference_date: b.reference_date })),
  };
}

export function describeAccount(a: StoredAccount, s?: StoredSession) {
  return {
    uid: a.uid,
    label: a.label ?? null,
    name: a.name ?? a.product ?? null,
    product: a.product ?? null,
    iban: a.iban ?? a.other_id ?? null,
    currency: a.currency,
    type: a.cash_account_type ?? null,
    bank: s ? `${s.bank.name} (${s.bank.country})` : null,
    consent_valid_until: s?.valid_until ?? null,
    consent_days_left: s ? daysLeft(s.valid_until) : null,
  };
}

export function daysLeft(iso: string): number {
  return Math.floor((Date.parse(iso) - Date.now()) / 86_400_000);
}

export function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function daysAgo(n: number): string {
  return isoDate(new Date(Date.now() - n * 86_400_000));
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
