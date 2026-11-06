// Cliente mínimo para APIs compatíveis com OpenAI (/chat/completions com
// tool calling): NVIDIA NIM, OpenRouter, Groq, Ollama, LM Studio, OpenAI…
// A extensão tem host_permissions <all_urls>, então o fetch não esbarra em CORS.

import type { ChatConfig } from "../store";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Part[] }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function base(cfg: ChatConfig): string {
  return cfg.baseUrl.trim().replace(/\/+$/, "");
}

function headers(cfg: ChatConfig): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey.trim()) h.Authorization = `Bearer ${cfg.apiKey.trim()}`;
  return h;
}

async function httpError(res: Response): Promise<Error> {
  const body = await res.text().catch(() => "");
  let detail = body;
  try {
    const j = JSON.parse(body);
    detail = j.error?.message ?? j.detail ?? j.message ?? j.title ?? body;
    if (typeof detail !== "string") detail = JSON.stringify(detail);
  } catch {
    /* corpo não é JSON */
  }
  const hint =
    res.status === 401 || res.status === 403
      ? " (confira a API key)"
      : res.status === 404
        ? " (confira a base URL e o nome do modelo)"
        : res.status === 429
          ? " (limite de requisições do provedor; espere um pouco)"
          : "";
  return new Error(`HTTP ${res.status}${hint}: ${detail.slice(0, 400)}`);
}

/** Remove raciocínio exposto por modelos como DeepSeek-R1/Qwen3. */
function stripThinking(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*?<\/think>/, "").trim();
}

/** Uma rodada de /chat/completions, com nova tentativa em 429/5xx. */
export async function complete(
  cfg: ChatConfig,
  messages: Message[],
  tools: ToolDef[],
  signal: AbortSignal,
): Promise<{ content: string; tool_calls: ToolCall[] }> {
  const body = JSON.stringify({
    model: cfg.model.trim(),
    messages,
    tools,
    tool_choice: "auto",
    temperature: 0.2,
    max_tokens: 4096,
    stream: false,
  });
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base(cfg)}/chat/completions`, { method: "POST", headers: headers(cfg), body, signal });
    if (res.ok) {
      const data = await res.json();
      const msg = data.choices?.[0]?.message ?? {};
      const calls: ToolCall[] = (msg.tool_calls ?? []).map((c: any, i: number) => ({
        id: c.id || `call_${Date.now()}_${i}`,
        type: "function",
        function: {
          name: c.function?.name ?? "",
          // alguns provedores mandam o objeto em vez da string JSON
          arguments: typeof c.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {}),
        },
      }));
      return { content: stripThinking(typeof msg.content === "string" ? msg.content : ""), tool_calls: calls };
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(attempt === 0 ? 3000 : 8000);
      continue;
    }
    throw await httpError(res);
  }
}

/** Lista os modelos do provedor (GET /models), para o autocompletar. */
export async function listModels(cfg: ChatConfig): Promise<string[]> {
  const res = await fetch(`${base(cfg)}/models`, { headers: headers(cfg) });
  if (!res.ok) throw await httpError(res);
  const data = await res.json();
  const list: unknown[] = data.data ?? data.models ?? [];
  return list
    .map((m: any) => (typeof m === "string" ? m : m.id ?? m.name))
    .filter((id): id is string => typeof id === "string")
    .sort();
}
