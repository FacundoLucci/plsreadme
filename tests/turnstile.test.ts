import assert from "node:assert/strict";
import test from "node:test";
import { verifyAnonymousTurnstile } from "../worker/turnstile.ts";

test("Turnstile fails closed when missing or not configured", async () => {
  assert.deepEqual(
    await verifyAnonymousTurnstile({} as any, { token: "token", ip: "127.0.0.1" }),
    { valid: false, reason: "not_configured" }
  );
  assert.deepEqual(
    await verifyAnonymousTurnstile({ TURNSTILE_SECRET_KEY: "secret" } as any, { token: null, ip: "127.0.0.1" }),
    { valid: false, reason: "missing" }
  );
});

test("Turnstile requires the upload action and an allowed hostname", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      success: true,
      action: "anonymous_upload",
      hostname: "plsreadme.com",
    }), { headers: { "Content-Type": "application/json" } });
    assert.deepEqual(
      await verifyAnonymousTurnstile(
        { TURNSTILE_SECRET_KEY: "secret" } as any,
        { token: "token", ip: "127.0.0.1" }
      ),
      { valid: true }
    );

    globalThis.fetch = async () => new Response(JSON.stringify({
      success: true,
      action: "login",
      hostname: "plsreadme.com",
    }), { headers: { "Content-Type": "application/json" } });
    assert.deepEqual(
      await verifyAnonymousTurnstile(
        { TURNSTILE_SECRET_KEY: "secret" } as any,
        { token: "token", ip: "127.0.0.1" }
      ),
      { valid: false, reason: "action_mismatch" }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
