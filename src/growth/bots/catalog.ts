/**
 * DataGoat's crawler catalog: who the crawler belongs to, what kind of request it makes, the
 * user-agent token that identifies it and, where the operator publishes them, the IP ranges used
 * to verify it. Classification and verification run on the server (the ai-crawl middleware only
 * pre-filters), so updating this file updates every install on its next deploy.
 *
 * Categories (DataFast's API values):
 * - `answer_fetch`: a user-triggered fetch so an assistant can answer a question right now.
 * - `search_index`: crawling to build or refresh a search / retrieval index.
 * - `training`: collecting public content that may be used to train models or build datasets.
 * - `ai_crawler`: other recognised AI or agent crawlers.
 *
 * Sources: every entry cites the operator's public documentation (`docs`). IP range sources are
 * the JSON files the operators publish (`ipSource`, see ip-ranges.ts). Entries are matched in
 * order; more specific tokens come first (e.g. "OAI-SearchBot" before "GPTBot").
 */

export type CrawlerCategory = "answer_fetch" | "search_index" | "training" | "ai_crawler";

export interface CrawlerDef {
  /** Stable id `Company::Agent::category`, DataFast's format. */
  id: string;
  company: string;
  /** The user-agent token as documented. */
  userAgent: string;
  category: CrawlerCategory;
  /** Case-insensitive pattern tested against the full User-Agent header. */
  pattern: RegExp;
  description: string;
  docs: string;
  /** Key into IP_SOURCES when the operator publishes IP ranges. */
  ipSource?: string;
}

function def(
  company: string,
  userAgent: string,
  category: CrawlerCategory,
  pattern: RegExp,
  description: string,
  docs: string,
  ipSource?: string,
): CrawlerDef {
  return {
    id: `${company}::${userAgent}::${category}`,
    company,
    userAgent,
    category,
    pattern,
    description,
    docs,
    ...(ipSource ? { ipSource } : {}),
  };
}

export const CRAWLERS: readonly CrawlerDef[] = [
  // OpenAI — https://platform.openai.com/docs/bots
  def(
    "OpenAI",
    "ChatGPT-User",
    "answer_fetch",
    /ChatGPT-User/i,
    "Fetches pages when a ChatGPT user or a Custom GPT asks about them.",
    "https://platform.openai.com/docs/bots",
    "openai-chatgpt-user",
  ),
  def(
    "OpenAI",
    "OAI-SearchBot",
    "search_index",
    /OAI-SearchBot/i,
    "Indexes pages so they can appear in ChatGPT search results.",
    "https://platform.openai.com/docs/bots",
    "openai-searchbot",
  ),
  def(
    "OpenAI",
    "GPTBot",
    "training",
    /GPTBot/i,
    "Crawls public content that may be used to train OpenAI's models.",
    "https://platform.openai.com/docs/bots",
    "openai-gptbot",
  ),

  // Anthropic — https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler
  def(
    "Anthropic",
    "Claude-User",
    "answer_fetch",
    /Claude-User/i,
    "Fetches pages when a Claude user asks about them.",
    "https://support.claude.com/en/articles/8896518",
  ),
  def(
    "Anthropic",
    "Claude-SearchBot",
    "search_index",
    /Claude-SearchBot/i,
    "Indexes pages to improve the quality of Claude's search results.",
    "https://support.claude.com/en/articles/8896518",
  ),
  def(
    "Anthropic",
    "ClaudeBot",
    "training",
    /ClaudeBot|Claude-Web|anthropic-ai/i,
    "Collects public web content that may be used to train Anthropic's models.",
    "https://support.claude.com/en/articles/8896518",
  ),

  // Perplexity — https://docs.perplexity.ai/guides/bots
  def(
    "Perplexity",
    "Perplexity-User",
    "answer_fetch",
    /Perplexity-User/i,
    "Fetches pages to answer a Perplexity user's question.",
    "https://docs.perplexity.ai/guides/bots",
    "perplexity-user",
  ),
  def(
    "Perplexity",
    "PerplexityBot",
    "search_index",
    /PerplexityBot/i,
    "Indexes pages so they can appear as sources in Perplexity answers.",
    "https://docs.perplexity.ai/guides/bots",
    "perplexitybot",
  ),

  // Google — https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers
  // and https://developers.google.com/search/docs/crawling-indexing/google-user-triggered-fetchers
  def(
    "Google",
    "Google-Agent",
    "answer_fetch",
    /Google-Agent|Google-NotebookLM|Google-Read-Aloud/i,
    "User-triggered fetches by Google products such as Gemini agents and NotebookLM.",
    "https://developers.google.com/search/docs/crawling-indexing/google-user-triggered-fetchers",
    "google-user-triggered",
  ),
  def(
    "Google",
    "Google-CloudVertexBot",
    "training",
    /Google-CloudVertexBot/i,
    "Crawls sites on request of site owners building Vertex AI agents.",
    "https://developers.google.com/search/docs/crawling-indexing/google-special-case-crawlers",
    "google-special",
  ),
  def(
    "Google",
    "GoogleOther",
    "training",
    /GoogleOther/i,
    "Generic Google crawler used by product teams, e.g. for research and development.",
    "https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers",
    "googlebot",
  ),
  def(
    "Google",
    "Googlebot",
    "search_index",
    /Googlebot|Google-InspectionTool|Storebot-Google/i,
    "Google Search's crawler (desktop and smartphone).",
    "https://developers.google.com/search/docs/crawling-indexing/googlebot",
    "googlebot",
  ),

  // Microsoft — https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0
  def(
    "Microsoft",
    "bingbot",
    "search_index",
    /bingbot|BingPreview|adidxbot/i,
    "Bing's crawler; Bing's index also grounds Microsoft Copilot answers.",
    "https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0",
    "bingbot",
  ),

  // Apple — https://support.apple.com/en-us/119829
  def(
    "Apple",
    "Applebot",
    "training",
    /Applebot/i,
    "Powers Siri and Spotlight search; content may be used to train Apple's models unless opted out with Applebot-Extended.",
    "https://support.apple.com/en-us/119829",
    "applebot",
  ),

  // Meta — https://developers.facebook.com/docs/sharing/webmasters/web-crawlers
  def(
    "Meta",
    "meta-externalfetcher",
    "answer_fetch",
    /meta-externalfetcher/i,
    "User-initiated fetches for Meta AI products.",
    "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers",
  ),
  def(
    "Meta",
    "meta-webindexer",
    "search_index",
    /meta-webindexer/i,
    "Indexes pages to improve Meta AI search results.",
    "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers",
  ),
  def(
    "Meta",
    "meta-externalagent",
    "training",
    /meta-externalagent/i,
    "Crawls content for training AI models and improving products.",
    "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers",
  ),
  def(
    "Meta",
    "facebookexternalhit",
    "ai_crawler",
    /facebookexternalhit|facebookcatalog/i,
    "Fetches link previews when a URL is shared on Facebook, Instagram or WhatsApp.",
    "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers",
  ),

  // DuckDuckGo — https://duckduckgo.com/duckduckgo-help-pages/results/duckduckbot
  def(
    "DuckDuckGo",
    "DuckAssistBot",
    "answer_fetch",
    /DuckAssistBot/i,
    "Fetches pages to write DuckAssist answers.",
    "https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot",
    "duckassistbot",
  ),
  def(
    "DuckDuckGo",
    "DuckDuckBot",
    "search_index",
    /DuckDuckBot/i,
    "DuckDuckGo's search crawler.",
    "https://duckduckgo.com/duckduckgo-help-pages/results/duckduckbot",
    "duckduckbot",
  ),

  // Mistral — https://docs.mistral.ai/robots/
  def(
    "Mistral",
    "MistralAI-User",
    "answer_fetch",
    /MistralAI-User/i,
    "Fetches pages when a Le Chat user asks about them.",
    "https://docs.mistral.ai/robots/",
  ),

  // Amazon — https://developer.amazon.com/amazonbot
  def(
    "Amazon",
    "Amazonbot",
    "training",
    /Amazonbot/i,
    "Improves Amazon products and services, which may include training Amazon AI models.",
    "https://developer.amazon.com/amazonbot",
  ),

  // ByteDance — https://bytedance.com/en/ (Bytespider identifies itself in its UA; no public ranges)
  def(
    "ByteDance",
    "Bytespider",
    "training",
    /Bytespider/i,
    "ByteDance's crawler, widely reported to collect training data for its models.",
    "https://bytedance.com/en/",
  ),

  // Common Crawl — https://commoncrawl.org/ccbot
  def(
    "Common Crawl",
    "CCBot",
    "training",
    /CCBot/i,
    "Builds the open Common Crawl dataset used to train many language models.",
    "https://commoncrawl.org/ccbot",
    "ccbot",
  ),

  // Cohere — https://docs.cohere.com/docs/cohere-crawlers (published crawler names)
  def(
    "Cohere",
    "cohere-training-data-crawler",
    "training",
    /cohere-training-data-crawler/i,
    "Collects data used to train Cohere's models.",
    "https://cohere.com/",
  ),
  def(
    "Cohere",
    "cohere-ai",
    "answer_fetch",
    /cohere-ai/i,
    "Fetches pages for Cohere chat users.",
    "https://cohere.com/",
  ),

  // You.com — https://about.you.com/youbot/
  def(
    "You.com",
    "YouBot",
    "search_index",
    /YouBot/i,
    "Indexes pages for You.com's AI search.",
    "https://about.you.com/youbot/",
  ),

  // Diffbot — https://docs.diffbot.com/docs/getting-started-with-crawl
  def(
    "Diffbot",
    "Diffbot",
    "training",
    /Diffbot/i,
    "Builds Diffbot's Knowledge Graph and datasets.",
    "https://www.diffbot.com/",
  ),

  // Huawei — https://aspiegel.com/petalbot
  def(
    "Huawei",
    "PetalBot",
    "search_index",
    /PetalBot/i,
    "Petal Search's crawler.",
    "https://aspiegel.com/petalbot",
  ),

  // Yandex — https://yandex.com/support/webmaster/robot-workings/check-yandex-robots.html
  def(
    "Yandex",
    "YandexBot",
    "search_index",
    /YandexBot|YandexAdditional/i,
    "Yandex search crawler.",
    "https://yandex.com/support/webmaster/robot-workings/check-yandex-robots.html",
  ),

  // Baidu — https://www.baidu.com/search/robots_english.html
  def(
    "Baidu",
    "Baiduspider",
    "search_index",
    /Baiduspider/i,
    "Baidu search crawler.",
    "https://www.baidu.com/search/robots_english.html",
  ),

  // Timpi — https://timpi.io/
  def(
    "Timpi",
    "Timpibot",
    "training",
    /Timpibot/i,
    "Crawls the web for Timpi's decentralised index and datasets.",
    "https://timpi.io/",
  ),

  // Webz.io (Omgili) — https://webz.io/bot.html
  def(
    "Webz.io",
    "omgili",
    "training",
    /omgili|webzio-extended/i,
    "Collects web data sold as datasets, including for AI training.",
    "https://webz.io/bot.html",
  ),

  // ImageSift — https://imagesift.com/about
  def(
    "ImageSift",
    "ImagesiftBot",
    "training",
    /ImagesiftBot/i,
    "Collects public images for its reverse image search and datasets.",
    "https://imagesift.com/about",
  ),

  // Allen Institute for AI — https://allenai.org/crawler
  def(
    "Ai2",
    "AI2Bot",
    "training",
    /AI2Bot/i,
    "Crawls public content for open research datasets and models.",
    "https://allenai.org/crawler",
  ),

  // Brave — https://search.brave.com/help/brave-search-crawler
  def(
    "Brave",
    "Bravebot",
    "search_index",
    /Bravebot/i,
    "Brave Search's crawler.",
    "https://search.brave.com/help/brave-search-crawler",
  ),
];

export const CRAWLERS_BY_ID: ReadonlyMap<string, CrawlerDef> = new Map(
  CRAWLERS.map((c) => [c.id, c]),
);

export const COMPANIES: readonly string[] = [...new Set(CRAWLERS.map((c) => c.company))];

/** Classify a User-Agent header. Returns null for anything that is not a catalogued crawler. */
export function classifyUserAgent(userAgent: string): CrawlerDef | null {
  if (!userAgent || userAgent.length > 1024) return null;
  for (const crawler of CRAWLERS) if (crawler.pattern.test(userAgent)) return crawler;
  return null;
}

export const CATEGORIES: readonly CrawlerCategory[] = [
  "answer_fetch",
  "search_index",
  "training",
  "ai_crawler",
];
