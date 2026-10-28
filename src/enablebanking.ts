// Thin typed client for the Enable Banking API. Every request carries an
// RS256 JWT signed with the application's private key (see the quick start at
// https://enablebanking.com/docs/api/quick-start/).
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { config, readPrivateKey } from "./config.ts";

export interface Amount {
  currency: string;
  amount: string;
}

export interface Aspsp {
  name: string;
  country: string;
  logo?: string;
  psu_types?: string[];
  maximum_consent_validity?: number;
  sandbox?: boolean;
  beta?: boolean;
}

export interface AccountResource {
  uid: string;
  account_id?: { iban?: string; other?: { identification?: string; scheme_name?: string } };
  name?: string;
  product?: string;
  currency: string;
  cash_account_type?: string;
  identification_hash: string;
}

export interface Balance {
  name?: string;
  balance_amount: Amount;
  balance_type: string;
  reference_date?: string;
  last_change_date_time?: string;
}

export interface Transaction {
  entry_reference?: string;
  transaction_id?: string;
  transaction_amount: Amount;
  credit_debit_indicator: "CRDT" | "DBIT";
  status: string;
  booking_date?: string;
  value_date?: string;
  transaction_date?: string;
  creditor?: { name?: string };
  debtor?: { name?: string };
  creditor_account?: { iban?: string; other?: { identification?: string } };
  debtor_account?: { iban?: string; other?: { identification?: string } };
  reference_number?: string;
  remittance_information?: string[];
  bank_transaction_code?: { code?: string; sub_code?: string; description?: string };
  merchant_category_code?: string;
  balance_after_transaction?: Amount;
  note?: string;
}

export interface Session {
  session_id: string;
  accounts: AccountResource[];
  aspsp: { name: string; country: string };
  psu_type: string;
  access: { valid_until: string };
}

export interface SessionStatus {
  status: string;
  accounts: string[];
  aspsp: { name: string; country: string };
  access: { valid_until: string };
  created: string;
  authorized?: string;
  closed?: string;
}

export interface Application {
  name: string;
  kid: string;
  environment: "SANDBOX" | "PRODUCTION";
  redirect_urls: string[];
  active: boolean;
}

export class EnableBankingError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`Enable Banking API ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
  /** True when the bank consent behind this call is no longer usable. */
  get consentGone(): boolean {
    if (this.rateLimited) return false;
    return this.status === 401 || this.status === 403 || this.status === 410 || /session|consent|expired|revoked/i.test(this.body);
  }
  /**
   * The bank refused because of the PSD2 limit on access without the account
   * holder present (usually four calls a day). Retrying before the bank's
   * stated time only extends the block.
   */
  get rateLimited(): boolean {
    return this.status === 429 || /RATE_LIMIT|too many requests/i.test(this.body);
  }
  /** When the bank says access works again, as an ISO timestamp, if it says so. */
  get retryAfter(): string | undefined {
    if (!this.rateLimited) return undefined;
    const iso = this.body.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g);
    const future = (iso ?? []).map((s) => Date.parse(s.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`)).filter((t) => !Number.isNaN(t) && t > Date.now());
    return future.length ? new Date(Math.max(...future)).toISOString() : undefined;
  }
}

// --- JWT ---

let keyObject: KeyObject | undefined;
let cachedToken: { value: string; exp: number } | undefined;

/** Forget the loaded key and token, e.g. after the setup page stored a new key. */
export function resetKeyCache(): void {
  keyObject = undefined;
  cachedToken = undefined;
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

export function makeJwt(now = Math.floor(Date.now() / 1000)): string {
  if (cachedToken && cachedToken.exp - now > 300) return cachedToken.value;
  keyObject ??= createPrivateKey(readPrivateKey());
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "RS256", kid: config.appId }));
  const payload = b64url(JSON.stringify({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now, exp: now + 3600 }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(keyObject).toString("base64url");
  cachedToken = { value: `${header}.${payload}.${signature}`, exp: now + 3600 };
  return cachedToken.value;
}

// --- HTTP ---

async function api<T>(method: string, path: string, body?: unknown, query?: Record<string, string | undefined>): Promise<T> {
  const url = new URL(path, config.apiBase);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${makeJwt()}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new EnableBankingError(res.status, text);
  return (text ? JSON.parse(text) : {}) as T;
}

export interface TransactionPage {
  transactions: Transaction[];
  continuation_key?: string;
}

export const eb = {
  getApplication: () => api<Application>("GET", "/application"),

  listAspsps: async (country: string) => (await api<{ aspsps: Aspsp[] }>("GET", "/aspsps", undefined, { country })).aspsps,

  startAuthorization: (input: { aspsp: Aspsp; state: string; redirectUrl: string; validUntil: Date; psuType?: string }) =>
    api<{ url: string; authorization_id: string; psu_id_hash: string }>("POST", "/auth", {
      access: { valid_until: input.validUntil.toISOString() },
      aspsp: { name: input.aspsp.name, country: input.aspsp.country },
      state: input.state,
      redirect_url: input.redirectUrl,
      psu_type: input.psuType ?? "personal",
    }),

  createSession: (code: string) => api<Session>("POST", "/sessions", { code }),
  getSession: (sessionId: string) => api<SessionStatus>("GET", `/sessions/${sessionId}`),
  deleteSession: (sessionId: string) => api<unknown>("DELETE", `/sessions/${sessionId}`),

  getBalances: async (accountUid: string) => (await api<{ balances: Balance[] }>("GET", `/accounts/${accountUid}/balances`)).balances,

  getTransactionPage: (accountUid: string, opts: { dateFrom?: string; dateTo?: string; continuationKey?: string } = {}) =>
    api<TransactionPage>("GET", `/accounts/${accountUid}/transactions`, undefined, {
      date_from: opts.dateFrom,
      date_to: opts.dateTo,
      continuation_key: opts.continuationKey,
    }),
};
