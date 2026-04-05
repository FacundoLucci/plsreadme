import { Hono } from "hono";
import type { Env } from "../types";
import {
  WRITE_RATE_LIMITS,
  checkAndConsumeRateLimit,
  getClientIp,
  logAbuseAttempt,
  parseContentLength,
  resolveRateLimitActorKey,
  sha256,
  validateContentLength,
} from "../security.ts";

export const convertRoutes = new Hono<{ Bindings: Env }>();

const MAX_INPUT_CHARS = 200 * 1024; // keep consistent with markdown upload limit
const DEFAULT_MODEL = "gpt-4.1-2025-04-14";
const DEFAULT_CF_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

const SYSTEM_PROMPT = [
  "You are a Markdown formatting assistant.",
  "Convert the user input into clean GitHub-Flavored Markdown (GFM).",
  "",
  "Rules:",
  "- Preserve meaning and ordering; do not add new facts.",
  "- Prefer headings, lists, tables, and code blocks when appropriate.",
  "- Keep URLs as markdown links when there is link text; otherwise keep bare URLs.",
  "- Preserve code snippets (use fenced code blocks when multi-line).",
  "- If the input already appears to be Markdown, return it unchanged.",
  "- Output ONLY the Markdown. No explanations, no surrounding backticks.",
].join("\n");

function extractResponseText(payload: any): string {
  if (typeof payload?.output_text === "string") return payload.output_text;

  const output = payload?.output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];

  for (const item of output) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const entry of content) {
      const text = entry?.text;
      if (typeof text === "string" && text.trim()) parts.push(text);
    }
  }

  return parts.join("\n").trim();
}

function extractCloudflareAIText(payload: any): string {
  if (typeof payload?.response === "string") return payload.response.trim();
  if (typeof payload?.result?.response === "string") return payload.result.response.trim();
  if (typeof payload?.output === "string") return payload.output.trim();
  return "";
}

// POST /api/convert - Convert plain text to markdown (OpenAI if configured, otherwise Workers AI)
convertRoutes.post("/", async (c) => {
  const endpoint = "/api/convert";
  const clientIp = getClientIp(c.req);
  const ipHash = await sha256(clientIp);
  const contentLength = parseContentLength(c.req.header("content-length"));

  try {
    const contentLengthFailure = validateContentLength(contentLength);
    if (contentLengthFailure) {
      await logAbuseAttempt(c.env, {
        endpoint,
        ipHash,
        reason: contentLengthFailure.reason,
        contentLength,
      });
      return c.json({ error: contentLengthFailure.message }, contentLengthFailure.status);
    }

    const actorKey = await resolveRateLimitActorKey({ ipHash });
    const rateLimit = await checkAndConsumeRateLimit(c.env, actorKey, WRITE_RATE_LIMITS.convert);
    if (!rateLimit.allowed) {
      await logAbuseAttempt(c.env, {
        endpoint,
        ipHash,
        reason: "rate_limit_exceeded",
        contentLength,
      });
      return c.json(
        {
          error: `Rate limit exceeded. Max ${rateLimit.maxRequests} conversions per hour.`,
          retry_after_seconds: rateLimit.retryAfterSeconds ?? 3600,
        },
        429
      );
    }

    const body = await c.req.json<{ text?: unknown }>().catch(() => ({} as any));
    const text = typeof body?.text === "string" ? body.text : "";

    if (!text || text.trim().length === 0) {
      return c.json({ error: "No input provided" }, 400);
    }
    if (text.length > MAX_INPUT_CHARS) {
      await logAbuseAttempt(c.env, {
        endpoint,
        ipHash,
        reason: "max_total_chars",
        contentLength,
        totalChars: text.length,
      });
      return c.json({ error: `Input too large. Maximum size is ${MAX_INPUT_CHARS / 1024} KB` }, 400);
    }

    const key = c.env.OPENAI_API_KEY;
    const hasWorkersAI = typeof c.env.AI?.run === "function";

    if (!key && !hasWorkersAI) {
      return c.json(
        { error: "AI conversion is not configured (set OPENAI_API_KEY or enable the Workers AI binding)" },
        503
      );
    }

    if (!key && hasWorkersAI) {
      const model = (c.env.CF_AI_MODEL || DEFAULT_CF_AI_MODEL).trim() || DEFAULT_CF_AI_MODEL;
      const payload = await c.env.AI!.run(model, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        temperature: 0.2,
        max_tokens: 1500,
      });

      const markdown = extractCloudflareAIText(payload).trim();
      if (!markdown) {
        console.error("Workers AI returned empty output:", { model, payload: JSON.stringify(payload).slice(0, 1000) });
        return c.json({ error: "AI returned empty output" }, 502);
      }

      return c.json({ markdown });
    }

    const model = (c.env.OPENAI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;

    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        temperature: 0.2,
        max_output_tokens: 1500,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("OpenAI convert failed:", {
        status: res.status,
        statusText: res.statusText,
        body: errText.slice(0, 1000),
      });
      return c.json({ error: "Failed to convert to Markdown" }, 502);
    }

    const payload = await res.json<any>();
    const markdown = extractResponseText(payload).trim();
    if (!markdown) {
      return c.json({ error: "AI returned empty output" }, 502);
    }

    return c.json({ markdown });
  } catch (error) {
    console.error("Convert error:", error);
    return c.json({ error: "Failed to convert to Markdown" }, 500);
  }
});
