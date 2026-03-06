import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "./types";

const textEncoder = new TextEncoder();
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const AUTH_CACHE_SYMBOL = Symbol.for("plsreadme.request.auth");

type TokenSource = "authorization" | "cookie" | "none";

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface JwtPayload {
  sub?: string;
  sid?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  email?: string;
  [key: string]: unknown;
}

interface Jwk {
  kid?: string;
  kty: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
}

interface CachedJwks {
  expiresAt: number;
  keys: Jwk[];
}

export interface RequestAuth {
  isAuthenticated: boolean;
  tokenSource: TokenSource;
  userId: string | null;
  sessionId: string | null;
  email: string | null;
  reason?: "missing_token" | "auth_not_configured" | "invalid_token";
}

const jwksCache = new Map<string, CachedJwks>();

function base64UrlToUint8Array(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function decodeJsonPart<T>(value: string): T {
  const bytes = base64UrlToUint8Array(value);
  const decoded = new TextDecoder().decode(bytes);
  return JSON.parse(decoded) as T;
}

function normalizeIssuer(issuer: string): string {
  return issuer.trim().replace(/\/+$/, "");
}

function parseCookieValue(cookieHeader: string, cookieName: string): string | null {
  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const [rawName, ...rest] = pair.trim().split("=");
    if (rawName !== cookieName) continue;
    const value = rest.join("=").trim();
    if (!value) return null;

    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}

function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function getRequestToken(c: Context<{ Bindings: Env }>): {
  token: string | null;
  source: TokenSource;
} {
  const authHeader = c.req.header("authorization")?.trim() ?? "";
  const cookieHeader = c.req.header("cookie") ?? "";
  const sessionCookie = parseCookieValue(cookieHeader, "__session");

  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice("bearer ".length).trim();
    if (token) {
      if (looksLikeJwt(token)) {
        return { token, source: "authorization" };
      }

      if (sessionCookie) {
        return { token: sessionCookie, source: "cookie" };
      }

      return { token: null, source: "none" };
    }
  }

  if (sessionCookie) {
    return { token: sessionCookie, source: "cookie" };
  }

  return { token: null, source: "none" };
}

function audienceMatches(payloadAud: JwtPayload["aud"], expectedAudience: string): boolean {
  if (!payloadAud) return false;

  if (Array.isArray(payloadAud)) {
    return payloadAud.includes(expectedAudience);
  }

  return payloadAud === expectedAudience;
}

function isExpired(exp: number | undefined, nowInSeconds: number): boolean {
  return typeof exp === "number" && exp <= nowInSeconds;
}

function isNotYetValid(nbf: number | undefined, nowInSeconds: number): boolean {
  return typeof nbf === "number" && nbf > nowInSeconds;
}

async function fetchJwks(jwksUrl: string): Promise<Jwk[]> {
  const now = Date.now();
  const cached = jwksCache.get(jwksUrl);
  if (cached && cached.expiresAt > now) {
    return cached.keys;
  }

  const response = await fetch(jwksUrl, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`JWKS fetch failed with status ${response.status}`);
  }

  const payload = await response.json<{ keys?: unknown }>();
  const keys = Array.isArray(payload.keys) ? (payload.keys as Jwk[]) : [];

  jwksCache.set(jwksUrl, {
    expiresAt: now + JWKS_CACHE_TTL_MS,
    keys,
  });

  return keys;
}

function selectJwk(keys: Jwk[], kid?: string): Jwk | null {
  const rsaKeys = keys.filter((key) => key.kty === "RSA" && typeof key.n === "string" && typeof key.e === "string");
  if (!rsaKeys.length) return null;

  if (kid) {
    const exactMatch = rsaKeys.find((key) => key.kid === kid);
    if (exactMatch) return exactMatch;
  }

  return rsaKeys[0] ?? null;
}

async function verifySignature(token: string, jwk: Jwk): Promise<boolean> {
  const [headerPart, payloadPart, signaturePart] = token.split(".");

  const data = textEncoder.encode(`${headerPart}.${payloadPart}`);
  const signature = base64UrlToUint8Array(signaturePart);

  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "RSA",
      n: jwk.n!,
      e: jwk.e!,
      alg: "RS256",
      ext: true,
    },
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["verify"]
  );

  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data);
}

async function resolveRequestAuthUncached(c: Context<{ Bindings: Env }>): Promise<RequestAuth> {
  const { token, source } = getRequestToken(c);

  if (!token) {
    return {
      isAuthenticated: false,
      tokenSource: "none",
      userId: null,
      sessionId: null,
      email: null,
      reason: "missing_token",
    };
  }

  const issuer = c.env.CLERK_JWT_ISSUER?.trim();
  if (!issuer) {
    return {
      isAuthenticated: false,
      tokenSource: source,
      userId: null,
      sessionId: null,
      email: null,
      reason: "auth_not_configured",
    };
  }

  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid JWT format");
    }

    const header = decodeJsonPart<JwtHeader>(parts[0]);
    const payload = decodeJsonPart<JwtPayload>(parts[1]);

    if (header.alg !== "RS256") {
      throw new Error("Unsupported JWT algorithm");
    }

    if (typeof payload.sub !== "string" || payload.sub.trim() === "") {
      throw new Error("JWT missing subject");
    }

    if (typeof payload.iss !== "string") {
      throw new Error("JWT missing issuer");
    }

    const normalizedIssuer = normalizeIssuer(issuer);
    const normalizedTokenIssuer = normalizeIssuer(payload.iss);

    if (normalizedIssuer !== normalizedTokenIssuer) {
      throw new Error("JWT issuer mismatch");
    }

    const nowInSeconds = Math.floor(Date.now() / 1000);
    if (isExpired(payload.exp, nowInSeconds)) {
      throw new Error("JWT expired");
    }

    if (isNotYetValid(payload.nbf, nowInSeconds)) {
      throw new Error("JWT not active yet");
    }

    const expectedAudience = c.env.CLERK_JWT_AUDIENCE?.trim();
    if (expectedAudience && !audienceMatches(payload.aud, expectedAudience)) {
      throw new Error("JWT audience mismatch");
    }

    const jwksUrl = `${normalizedIssuer}/.well-known/jwks.json`;
    const keys = await fetchJwks(jwksUrl);
    const key = selectJwk(keys, header.kid);

    if (!key) {
      throw new Error("No matching JWK for JWT");
    }

    const validSignature = await verifySignature(token, key);
    if (!validSignature) {
      throw new Error("JWT signature invalid");
    }

    return {
      isAuthenticated: true,
      tokenSource: source,
      userId: payload.sub,
      sessionId: typeof payload.sid === "string" ? payload.sid : null,
      email: typeof payload.email === "string" ? payload.email : null,
    };
  } catch (error) {
    console.warn("Auth verification failed", {
      source,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      isAuthenticated: false,
      tokenSource: source,
      userId: null,
      sessionId: null,
      email: null,
      reason: "invalid_token",
    };
  }
}

function getCachedAuth(c: Context<{ Bindings: Env }>): RequestAuth | null {
  const rawRequest = c.req.raw as Request & { [AUTH_CACHE_SYMBOL]?: RequestAuth };
  return rawRequest[AUTH_CACHE_SYMBOL] ?? null;
}

function setCachedAuth(c: Context<{ Bindings: Env }>, auth: RequestAuth): void {
  const rawRequest = c.req.raw as Request & { [AUTH_CACHE_SYMBOL]?: RequestAuth };
  rawRequest[AUTH_CACHE_SYMBOL] = auth;
}

export async function getRequestAuth(c: Context<{ Bindings: Env }>): Promise<RequestAuth> {
  const cached = getCachedAuth(c);
  if (cached) return cached;

  const resolved = await resolveRequestAuthUncached(c);
  setCachedAuth(c, resolved);
  return resolved;
}

export const attachRequestAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await getRequestAuth(c);
  await next();
};

export async function requireAuth(c: Context<{ Bindings: Env }>): Promise<RequestAuth | Response> {
  const auth = await getRequestAuth(c);

  if (!auth.isAuthenticated) {
    return c.json(
      {
        error: "Authentication required",
        code: "auth_required",
      },
      401
    );
  }

  return auth;
}
