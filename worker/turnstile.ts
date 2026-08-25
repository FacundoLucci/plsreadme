import type { Env } from "./types.ts";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_ACTION = "anonymous_upload";

type SiteverifyResponse = {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
};

export type TurnstileResult =
  | { valid: true }
  | { valid: false; reason: "not_configured" | "missing" | "failed" | "action_mismatch" | "hostname_mismatch" };

function allowedHostname(hostname: string | undefined): boolean {
  return hostname === "plsreadme.com" || hostname === "www.plsreadme.com" || hostname === "plsrd.me";
}

export async function verifyAnonymousTurnstile(
  env: Env,
  input: { token: string | null; ip: string }
): Promise<TurnstileResult> {
  const secret = env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return { valid: false, reason: "not_configured" };
  if (!input.token?.trim()) return { valid: false, reason: "missing" };

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: input.token.trim(), remoteip: input.ip }),
    });
    const result = await response.json<SiteverifyResponse>();
    if (!response.ok || !result.success) return { valid: false, reason: "failed" };
    if (result.action !== TURNSTILE_ACTION) return { valid: false, reason: "action_mismatch" };
    if (!allowedHostname(result.hostname)) return { valid: false, reason: "hostname_mismatch" };
    return { valid: true };
  } catch (error) {
    console.error("Turnstile validation failed", error);
    return { valid: false, reason: "failed" };
  }
}
