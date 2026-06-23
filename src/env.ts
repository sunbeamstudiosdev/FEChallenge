/**
 * Tiny env helper. No t3-env on purpose — keep the dependency surface small
 * and the defaults obvious. Everything has a sensible default so the app runs
 * with zero configuration.
 */

export type AiProvider = "mock" | "anthropic" | "openai" | "bedrock";

export const env = {
  /** Which model provider the agent uses. Defaults to the offline mock. */
  AI_PROVIDER: (process.env.AI_PROVIDER ?? "mock") as AiProvider,

  /** Model ids per provider (only read when that provider is selected). */
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
  OPENAI_MODEL: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  BEDROCK_MODEL:
    process.env.BEDROCK_MODEL ??
    "anthropic.claude-3-5-sonnet-20240620-v1:0",

  /**
   * Optional gateway base URL. When set, the anthropic/openai providers route
   * through it — point this at a Vercel AI Gateway or Cloudflare AI Gateway
   * endpoint. Leave unset to call the provider directly. See `.env.example`.
   *
   * For Cloudflare + Anthropic the SDK appends `/messages`, so this must end in
   * `/anthropic/v1`:
   *   https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway>/anthropic/v1
   */
  AI_GATEWAY_BASE_URL: process.env.AI_GATEWAY_BASE_URL,

  /**
   * Optional Cloudflare AI Gateway authorization token. Set this only when the
   * gateway is configured as "authenticated" — it's sent as
   * `cf-aig-authorization: Bearer <token>` so requests must carry your gateway
   * secret, not just an Anthropic key. Leave unset for an unauthenticated gateway.
   */
  AI_GATEWAY_TOKEN: process.env.AI_GATEWAY_TOKEN,

  /**
   * Cloudflare AI Gateway response caching (only applied when routing through
   * the gateway). Set a TTL in seconds (60..2592000) to opt our requests into
   * caching via the `cf-aig-cache-ttl` header. Leave unset to follow the
   * gateway's own default-caching setting.
   */
  AI_GATEWAY_CACHE_TTL: process.env.AI_GATEWAY_CACHE_TTL,

  /**
   * Set to "true" to send `cf-aig-skip-cache` and bypass the cache — handy in a
   * live demo when you want every answer to reflect the freshest data.
   */
  AI_GATEWAY_SKIP_CACHE: process.env.AI_GATEWAY_SKIP_CACHE,

  /** File-backed PGlite directory, shared by the seed and dev processes. */
  PGLITE_DIR: process.env.PGLITE_DIR ?? "./.pglite",
} as const;
