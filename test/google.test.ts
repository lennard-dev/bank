import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ADMIN_PASSWORD = "correct horse";
process.env.BASE_URL = "https://bank.example.org";
const { SingleUserProvider } = await import("../src/auth.ts");
const { Store } = await import("../src/store.ts");

const CLIENT_ID = "test-client.apps.googleusercontent.com";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (claims: Record<string, unknown>) => `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;

function withGoogle<T>(emails: string, fn: () => Promise<T>): Promise<T> {
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.ALLOWED_EMAILS = emails;
  return fn().finally(() => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.ALLOWED_EMAILS;
  });
}

/** Provider whose "Google" answers with an id token for `email`; `nonceFor` lets a test break the nonce. */
async function setup(email: string, opts: { nonceFor?: (requestId: string) => string; seen?: string[] } = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "bank-")), "store.json"));
  let currentRequest = "";
  const fakeFetch = (async (_url: string, init: { body: URLSearchParams }) => {
    opts.seen?.push(init.body.toString());
    const nonce = opts.nonceFor ? opts.nonceFor(currentRequest) : sha256(`nonce:${currentRequest}`);
    const token = idToken({ iss: "https://accounts.google.com", aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 300, nonce, email, email_verified: true });
    return { ok: true, status: 200, json: async () => ({ id_token: token }) };
  }) as unknown as typeof fetch;
  const events: Array<{ ok: boolean; user?: string; reason?: string }> = [];
  const provider = new SingleUserProvider(store, { fetch: fakeFetch, onLogin: (e) => events.push(e) });
  const client = await provider.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude", token_endpoint_auth_method: "none" });
  const out = { body: "" };
  const res = { status: () => res, type: () => res, send: (b: string) => ((out.body = b), res) } as unknown as import("express").Response;
  await provider.authorize(client, { codeChallenge: "challenge", redirectUri: client.redirect_uris[0]!, state: "xyz", scopes: ["bank:read"] }, res);
  const requestId = decodeURIComponent(/\/auth\/google\?request=([^"]+)"/.exec(out.body)?.[1] ?? "");
  currentRequest = requestId;
  return { store, provider, client, requestId, page: out.body, events };
}

test("Google sign-in: listed person gets in and the token remembers who it is", () =>
  withGoogle("silvia@europecares.org, lennard.everwien@europecares.org", async () => {
    const seen: string[] = [];
    const { provider, client, requestId, page, events, store } = await setup("Silvia@EuropeCares.org", { seen });
    assert.match(page, /Sign in with Google/);
    assert.doesNotMatch(page, /type="password"/, "no password field in Google mode");

    const start = provider.googleStartUrl(requestId);
    assert.ok("redirect" in start);
    const g = new URL(start.redirect);
    assert.equal(g.origin, "https://accounts.google.com");
    assert.equal(g.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(g.searchParams.get("redirect_uri"), "https://bank.example.org/auth/google/callback");
    assert.equal(g.searchParams.get("state"), requestId);
    assert.equal(g.searchParams.get("nonce"), sha256(`nonce:${requestId}`));

    const done = await provider.completeGoogleLogin(requestId, "google-code", "1.2.3.4");
    assert.ok("redirect" in done, JSON.stringify(done));
    assert.match(seen[0]!, /code=google-code/);
    assert.match(seen[0]!, /client_secret=secret/);
    const code = new URL(done.redirect).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0]);
    const info = await provider.verifyAccessToken(tokens.access_token);
    assert.deepEqual(info.extra, { user: "silvia@europecares.org" });
    assert.deepEqual(events.at(-1), { ok: true, ip: "1.2.3.4", clientName: "Claude", user: "silvia@europecares.org" });
    assert.ok(Object.values(store.data.oauth.tokens).every((t) => t.user === "silvia@europecares.org"));

    assert.ok("error" in (await provider.completeGoogleLogin(requestId, "google-code", "1.2.3.4")), "request is single use");
  }));

test("Google sign-in: someone not on the list is turned away", () =>
  withGoogle("silvia@europecares.org", async () => {
    const { provider, requestId, events } = await setup("stranger@gmail.com");
    const done = await provider.completeGoogleLogin(requestId, "code", "5.6.7.8");
    assert.ok("error" in done);
    assert.match(done.error, /stranger@gmail\.com is not on the list/);
    assert.equal(events.at(-1)?.ok, false);
    assert.equal(events.at(-1)?.user, "stranger@gmail.com");
  }));

test("Google sign-in: a token for another sign-in request is rejected", () =>
  withGoogle("silvia@europecares.org", async () => {
    const { provider, requestId } = await setup("silvia@europecares.org", { nonceFor: () => "someone-elses-nonce" });
    const done = await provider.completeGoogleLogin(requestId, "code", "1.1.1.1");
    assert.ok("error" in done && /does not belong to this request/.test(done.error));
  }));

test("Google sign-in: removing an address cuts off existing access and refresh tokens", () =>
  withGoogle("silvia@europecares.org,arno@europecares.org", async () => {
    const { provider, client, requestId } = await setup("arno@europecares.org");
    const done = await provider.completeGoogleLogin(requestId, "code", "1.1.1.1");
    assert.ok("redirect" in done);
    const tokens = await provider.exchangeAuthorizationCode(client, new URL(done.redirect).searchParams.get("code")!);
    await provider.verifyAccessToken(tokens.access_token);

    process.env.ALLOWED_EMAILS = "silvia@europecares.org";
    await assert.rejects(provider.verifyAccessToken(tokens.access_token), /removed/);
    await assert.rejects(provider.exchangeRefreshToken(client, tokens.refresh_token!), /removed/);
  }));

test("Google sign-in: the password form is refused and password tokens stop working", () =>
  withGoogle("silvia@europecares.org", async () => {
    const { provider, requestId } = await setup("silvia@europecares.org");
    const r = provider.completeLogin(requestId, "correct horse", "1.1.1.1");
    assert.ok("error" in r && /Google sign-in/.test(r.error));
  }));

test("Google start URL is refused while Google sign-in is off", async () => {
  const provider = new SingleUserProvider(new Store(join(mkdtempSync(join(tmpdir(), "bank-")), "store.json")));
  const r = provider.googleStartUrl("anything");
  assert.ok("error" in r);
});
