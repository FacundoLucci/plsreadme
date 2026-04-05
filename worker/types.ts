import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  ANALYTICS: AnalyticsEngineDataset;
  ASSETS: Fetcher;
  DOCS_BUCKET: R2Bucket;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV?: KVNamespace; // Required in deployed environments for hosted remote MCP OAuth token storage
  OAUTH_PROVIDER?: OAuthHelpers;
  DISCORD_WEBHOOK_URL?: string;        // Optional Discord webhook (used for waitlist notifications)
  DISCORD_LINK_WEBHOOK_URL?: string;   // Optional Discord webhook (used for link/doc creation notifications)
  RESEND_API_KEY?: string;       // Optional Resend API key for email notifications
  NOTIFICATION_EMAIL?: string;   // Your email to receive notifications
  // Workers AI binding (optional fallback for /api/convert when no OpenAI key is configured)
  AI?: CloudflareAI;
  OPENAI_API_KEY?: string;       // Optional OpenAI API key for text->markdown conversion
  OPENAI_MODEL?: string;         // Optional OpenAI model override
  CF_AI_MODEL?: string;          // Optional Workers AI model override
  CLERK_PUBLISHABLE_KEY?: string; // Optional Clerk publishable key for frontend auth
  CLERK_SECRET_KEY?: string;      // Optional Clerk secret key (reserved for future server-side use)
  CLERK_JWT_ISSUER?: string;      // Optional Clerk JWT issuer used for backend token verification
  CLERK_JWT_AUDIENCE?: string;    // Optional expected Clerk JWT audience claim
  CLERK_SIGN_IN_URL?: string;     // Optional Clerk sign-in route/path
  CLERK_SIGN_UP_URL?: string;     // Optional Clerk sign-up route/path
}

export interface CloudflareAI {
  run(model: string, input: unknown): Promise<any>;
}

export interface WaitlistSignup {
  id: number;
  email: string;
  created_at: string;
  requested_features: string | null;
  source: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  referrer: string | null;
  landing_path: string | null;
  user_agent: string | null;
  ip_hash: string | null;
}

export interface TrackingEvent {
  event: string;
  path: string;
  referrer: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  anon_id: string;
  cta_location?: string;
  timestamp: number;
}

export interface CommentRecord {
  id: string;
  doc_id: string;
  author_name: string;
  author_user_id: string | null;
  author_email: string | null;
  author_display_name: string | null;
  body: string;
  anchor_id: string;
  created_at: string;
  ip_hash: string | null;
  flagged: number;
  doc_version: number;
}

export interface DocRecord {
  id: string;
  r2_key: string;
  content_type: string;
  bytes: number;
  created_at: string;
  sha256: string | null;
  title: string | null;
  view_count: number;
  raw_view_count: number;
  admin_token: string | null;
  doc_version: number;
  owner_user_id: string | null;
}
