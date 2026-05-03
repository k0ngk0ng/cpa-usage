// Helpers that turn provider-specific request/response envelopes into the
// human-readable bits — the messages a user typed, and the text the model
// streamed back. The "raw" view in the log modal still shows the original
// bytes; this is just a friendlier projection.
//
// Supported shapes:
//   - Anthropic /v1/messages (messages: [{role, content: string | parts[]}], system)
//   - OpenAI chat completions (messages: [{role, content}])
//   - OpenAI Responses (input: [...], output: [...])
//   - Gemini generateContent (contents: [{role, parts}])
// SSE response shapes covered: Anthropic content_block_delta /
// thinking_delta, OpenAI chat delta.content / delta.reasoning, OpenAI
// Responses output_text.delta / reasoning_summary_text.delta, Gemini
// candidates[].content.parts[].text.

export interface Turn {
  role: string;
  text: string;
  attachments?: string[];
}

export function extractRequestTurns(rawJson: string): Turn[] | null {
  let obj: unknown;
  try {
    obj = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;

  const turns: Turn[] = [];

  const sys = o.system;
  if (typeof sys === "string" && sys.trim()) {
    turns.push({ role: "system", text: sys });
  } else if (Array.isArray(sys)) {
    const text = sys
      .map((p) => (typeof p === "string" ? p : (p as { text?: string })?.text || ""))
      .filter(Boolean)
      .join("\n");
    if (text.trim()) turns.push({ role: "system", text });
  }

  if (Array.isArray(o.messages)) {
    for (const m of o.messages) turns.push(messageToTurn(m));
  }
  if (Array.isArray(o.input)) {
    for (const m of o.input) turns.push(messageToTurn(m));
  }
  if (Array.isArray(o.contents)) {
    for (const m of o.contents) turns.push(geminiContentToTurn(m));
  }

  return turns.length > 0 ? turns : null;
}

function messageToTurn(raw: unknown): Turn {
  const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const role = String(m.role || "user");
  const content = m.content ?? m.text;
  let text = "";
  const attachments: string[] = [];

  const append = (chunk: string) => {
    if (!chunk) return;
    text += (text ? "\n\n" : "") + chunk;
  };

  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      const type = String(p.type || "");
      if (type === "text" || type === "input_text" || type === "output_text") {
        const t = String(p.text ?? "");
        if (t) append(t);
      } else if (type === "thinking" || type === "reasoning") {
        const t = String(p.thinking ?? p.text ?? "");
        if (t) {
          const quoted = t.split("\n").map((l) => "> " + l).join("\n");
          append("_thinking_\n" + quoted);
        }
      } else if (type === "tool_use") {
        const name = String(p.name || "tool");
        const input = JSON.stringify(p.input ?? {}, null, 2);
        append(`**[tool_use ${name}]**\n\n\`\`\`json\n${input}\n\`\`\``);
      } else if (type === "tool_result") {
        const id = p.tool_use_id ? ` ${p.tool_use_id}` : "";
        const c = typeof p.content === "string"
          ? p.content
          : Array.isArray(p.content)
            ? p.content
                .map((ci) =>
                  ci && typeof ci === "object" && typeof (ci as { text?: string }).text === "string"
                    ? (ci as { text: string }).text
                    : JSON.stringify(ci),
                )
                .join("\n")
            : JSON.stringify(p.content ?? "");
        append(`**[tool_result${id}]**\n\n\`\`\`\n${c}\n\`\`\``);
      } else if (type === "image" || type === "input_image") {
        attachments.push("image");
      } else if (type) {
        attachments.push(type);
      }
    }
  }

  return { role, text, attachments: attachments.length ? attachments : undefined };
}

function geminiContentToTurn(raw: unknown): Turn {
  const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const role = String(m.role || "user");
  const parts = Array.isArray(m.parts) ? m.parts : [];
  const text = parts
    .map((p) => (p && typeof p === "object" ? (p as { text?: string }).text || "" : ""))
    .filter(Boolean)
    .join("\n\n");
  const attachments = parts
    .filter((p) => p && typeof p === "object" && !(p as { text?: string }).text)
    .map((p) => {
      const o = p as Record<string, unknown>;
      if (o.inlineData) return "inline data";
      if (o.functionCall) return `function_call ${(o.functionCall as { name?: string })?.name || ""}`;
      if (o.functionResponse) return "function_response";
      return Object.keys(o).join(",") || "part";
    });
  return { role, text, attachments: attachments.length ? attachments : undefined };
}


export interface StreamExtraction {
  detected: boolean;
  content: string;
  thinking: string;
  errors: string[];
}

interface AnthropicBlock {
  index: number;
  type: string;
  name?: string;
  text: string;
  partialJSON: string;
}

export function extractResponseStream(text: string): StreamExtraction {
  const out: StreamExtraction = { detected: false, content: "", thinking: "", errors: [] };
  if (!text) return out;

  // Anthropic content blocks are reassembled by index — tool_use blocks
  // arrive as a stream of input_json_delta.partial_json chunks that have to
  // be concatenated to recover the actual call arguments. text_delta /
  // thinking_delta also belong to a block, so we route them through the same
  // map and render in declaration order.
  const blocks = new Map<number, AnthropicBlock>();
  const blockOrder: number[] = [];

  // CPA logs the SSE stream as-is plus a leading "Status: 200" / header
  // block. Walk line by line and only act on `data:` rows.
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    out.detected = true;
    let obj: unknown;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const o = obj as Record<string, unknown>;

    // Anthropic
    if (o.type === "content_block_start") {
      const block = (o.content_block as Record<string, unknown>) || {};
      const idx = typeof o.index === "number" ? (o.index as number) : blockOrder.length;
      if (!blocks.has(idx)) blockOrder.push(idx);
      blocks.set(idx, {
        index: idx,
        type: String(block.type || "text"),
        name: typeof block.name === "string" ? block.name : undefined,
        text: "",
        partialJSON: "",
      });
    }
    if (o.type === "content_block_delta") {
      const idx = typeof o.index === "number" ? (o.index as number) : -1;
      const b = blocks.get(idx);
      const d = (o.delta as Record<string, unknown>) || {};
      const dt = d.type;
      if (dt === "text_delta" && typeof d.text === "string") {
        if (b) b.text += d.text;
        else out.content += d.text;
      } else if (dt === "thinking_delta" && typeof d.thinking === "string") {
        if (b) b.text += d.thinking;
        else out.thinking += d.thinking;
      } else if (dt === "input_json_delta" && typeof d.partial_json === "string") {
        if (b) b.partialJSON += d.partial_json;
      }
    }
    if (o.type === "error") {
      const err = o.error as Record<string, unknown> | undefined;
      out.errors.push(String(err?.message || JSON.stringify(o)));
    }

    // OpenAI Responses
    if (typeof o.type === "string" && (o.type as string).endsWith(".delta")) {
      if (o.type === "response.output_text.delta" && typeof o.delta === "string") {
        out.content += o.delta;
      }
      if (
        (o.type === "response.reasoning_summary_text.delta" ||
          o.type === "response.reasoning_text.delta") &&
        typeof o.delta === "string"
      ) {
        out.thinking += o.delta;
      }
    }

    // OpenAI chat completions
    const choices = o.choices as unknown[] | undefined;
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as Record<string, unknown>;
      const delta = (first.delta || first.message) as Record<string, unknown> | undefined;
      if (delta) {
        if (typeof delta.content === "string") out.content += delta.content;
        if (typeof delta.reasoning === "string") out.thinking += delta.reasoning;
        if (typeof delta.reasoning_content === "string") out.thinking += delta.reasoning_content;
      }
    }

    // Gemini
    const candidates = o.candidates as unknown[] | undefined;
    if (Array.isArray(candidates) && candidates.length > 0) {
      const first = candidates[0] as Record<string, unknown>;
      const content = first.content as Record<string, unknown> | undefined;
      const parts = content?.parts as unknown[] | undefined;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          if (p && typeof p === "object" && typeof (p as { text?: string }).text === "string") {
            out.content += (p as { text: string }).text;
          }
        }
      }
    }
  }

  // Flush Anthropic blocks in the order they were declared so tool_use calls
  // appear inline alongside the assistant's prose.
  for (const idx of blockOrder) {
    const b = blocks.get(idx);
    if (!b) continue;
    if (b.type === "text") {
      out.content += b.text;
    } else if (b.type === "thinking") {
      out.thinking += b.text;
    } else if (b.type === "tool_use") {
      const json = formatPartialJSON(b.partialJSON);
      const name = b.name || "tool";
      const sep = out.content ? "\n\n" : "";
      out.content += `${sep}**[tool_use ${name}]**\n\n\`\`\`json\n${json}\n\`\`\``;
    }
  }

  return out;
}

// formatPartialJSON tries to pretty-print the accumulated input_json_delta.
// The stream may have been truncated mid-token, so on parse failure we fall
// back to the raw concatenation.
function formatPartialJSON(raw: string): string {
  const t = raw.trim();
  if (!t) return "{}";
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return raw;
  }
}

// extractResponseJSON handles non-streaming JSON responses (e.g. the upstream
// 4xx body in an API RESPONSE attempt). Returns null when nothing useful is
// found.
export function extractResponseJSON(rawJson: string): StreamExtraction | null {
  let obj: unknown;
  try {
    obj = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const out: StreamExtraction = { detected: false, content: "", thinking: "", errors: [] };

  // Anthropic non-streaming: { content: [{type:'text', text:'...'}, {type:'thinking', thinking:'...'}, {type:'tool_use', name, input}] }
  if (Array.isArray(o.content)) {
    for (const part of o.content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") {
        out.content += p.text;
        out.detected = true;
      } else if (p.type === "thinking" && typeof p.thinking === "string") {
        out.thinking += p.thinking;
        out.detected = true;
      } else if (p.type === "tool_use") {
        const name = String(p.name || "tool");
        const input = JSON.stringify(p.input ?? {}, null, 2);
        const sep = out.content ? "\n\n" : "";
        out.content += `${sep}**[tool_use ${name}]**\n\n\`\`\`json\n${input}\n\`\`\``;
        out.detected = true;
      }
    }
  }

  // OpenAI chat completions non-streaming
  const choices = o.choices as unknown[] | undefined;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const msg = first.message as Record<string, unknown> | undefined;
    if (msg) {
      if (typeof msg.content === "string" && msg.content) {
        out.content += msg.content;
        out.detected = true;
      }
      if (typeof msg.reasoning === "string" && msg.reasoning) {
        out.thinking += msg.reasoning;
        out.detected = true;
      }
    }
  }

  // OpenAI Responses non-streaming: { output: [ { type:'message', content:[...]} ] }
  if (Array.isArray(o.output)) {
    for (const item of o.output) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      const c = it.content;
      if (Array.isArray(c)) {
        for (const part of c) {
          if (!part || typeof part !== "object") continue;
          const p = part as Record<string, unknown>;
          if ((p.type === "output_text" || p.type === "text") && typeof p.text === "string") {
            out.content += p.text;
            out.detected = true;
          }
        }
      }
    }
  }

  // Errors (rate limit responses etc.)
  const err = o.error as Record<string, unknown> | undefined;
  if (err && typeof err.message === "string") {
    out.errors.push(`${err.type ? err.type + ": " : ""}${err.message}`);
    out.detected = true;
  }

  return out.detected ? out : null;
}

// turnsToMarkdown renders a list of conversation turns as a single markdown
// document with each role as a heading.
export function turnsToMarkdown(turns: Turn[]): string {
  return turns
    .map((t) => {
      let out = `## ${t.role}\n\n${t.text || "_(empty)_"}`;
      if (t.attachments?.length) {
        out += `\n\n_attachments_: ${t.attachments.join("; ")}`;
      }
      return out;
    })
    .join("\n\n---\n\n");
}

// streamToMarkdown formats the extracted content (and thinking, if any) as a
// markdown document.
export function streamToMarkdown(s: StreamExtraction): string {
  const parts: string[] = [];
  if (s.thinking.trim()) {
    const quoted = s.thinking.trim().split("\n").map((l) => "> " + l).join("\n");
    parts.push("**Thinking**\n\n" + quoted);
  }
  if (s.content.trim()) {
    parts.push(s.content);
  }
  if (s.errors.length) {
    parts.push("**Errors**\n\n" + s.errors.map((e) => "- " + e).join("\n"));
  }
  return parts.join("\n\n---\n\n") || "_(empty)_";
}
