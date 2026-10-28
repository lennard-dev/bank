import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The store and ledger read DATA_DIR at import time, so set it first.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "sync-"));
const { store } = await import("../src/store.ts");
const { EnableBankingError } = await import("../src/enablebanking.ts");
const { bankCall, BankBlockedError, blockedUntil } = await import("../src/sync.ts");

const seed = () => {
  store().addSession({
    session_id: "s1",
    aspsp: { name: "National Bank of Greece", country: "GR" },
    psu_type: "business",
    access: { valid_until: "2027-04-03T00:00:00Z" },
    accounts: [{ uid: "u1", name: "Paréa", currency: "EUR", identification_hash: "h1" }],
  });
  return store().account("u1")!;
};

test("a 429 blocks the account and no further call is made until the bank's time", async () => {
  const account = seed();
  const until = new Date(Date.now() + 2 * 3_600_000).toISOString();
  let calls = 0;
  await assert.rejects(
    bankCall(account, async () => {
      calls += 1;
      throw new EnableBankingError(429, `ASPSP_RATE_LIMIT_EXCEEDED, can be retried after ${until}`);
    }),
    BankBlockedError,
  );
  assert.equal(store().account("u1")!.blocked_until, until);
  assert.equal(blockedUntil(store().account("u1")!), until);
  await assert.rejects(
    bankCall(store().account("u1")!, async () => {
      calls += 1;
      return 1;
    }),
    BankBlockedError,
  );
  assert.equal(calls, 1, "the second call never reached the bank");
});

test("without a retry time the block lasts a day", async () => {
  store().update((d) => void delete d.accounts["u1"]!.blocked_until);
  const account = store().account("u1")!;
  await assert.rejects(bankCall(account, async () => { throw new EnableBankingError(429, "Too Many Requests"); }), BankBlockedError);
  const left = Date.parse(store().account("u1")!.blocked_until!) - Date.now();
  assert.ok(left > 23 * 3_600_000 && left <= 24 * 3_600_000);
});

test("other bank errors pass through untouched", async () => {
  store().update((d) => void delete d.accounts["u1"]!.blocked_until);
  const account = store().account("u1")!;
  await assert.rejects(bankCall(account, async () => { throw new EnableBankingError(422, "Wrong transactions period requested"); }), EnableBankingError);
  assert.equal(store().account("u1")!.blocked_until, undefined);
});
