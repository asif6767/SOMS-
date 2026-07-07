// Optional drop-in LLM rewrite hook

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const TIMEOUT_MS = 4000;

export function llmEnabled() {
  return Boolean(ANTHROPIC_API_KEY) && process.env.USE_LLM_RESPONSES !== "false";
}

/**
 * Rewrites a template string in a more conversational tone.
 * @param {string} templateText - formatters.js output (ground truth)
 * @param {string} context - short label, e.g. "power usage"
 * @returns {Promise<string|null>} rewritten text, or null on failure
 */
export async function humanize(templateText, context) {
  if (!llmEnabled()) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        system:
          "You rewrite office-monitoring bot messages to sound warmer and more " +
          "conversational for a Discord chat. Rules: keep every number, room " +
          "name, and device name EXACTLY as given — never change, round, or " +
          "invent a figure. Keep it to 1-3 short sentences. Keep any emoji the " +
          "original used, or drop them, your choice. Reply with ONLY the " +
          "rewritten message, no preamble, no quotes.",
        messages: [
          {
            role: "user",
            content: `Context: ${context}\n\nOriginal message:\n${templateText}`,
          },
        ],
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.content?.find((b) => b.type === "text")?.text;
    return text ? text.trim() : null;
  } catch {
    // Any failure falls back to the template
    return null;
  } finally {
    clearTimeout(timer);
  }
}
