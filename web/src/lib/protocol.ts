// Helpers that turn provider-specific request/response envelopes into the
// human-readable bits — the messages a user typed, and the text the model
// streamed back. The "raw" view in the log modal still shows the original
// bytes; this is just a friendlier projection.
//
// Supported shapes:
//   - Anthropic /v1/messages (messages: [{role, content: string | parts[]}], system)
//   - OpenAI chat completions (messages: [{role, content}])
//   - OpenAI Responses (instructions, input: [...], output: [...])
//   - Gemini generateContent (systemInstruction, contents: [{role, parts}])
// SSE response shapes covered: Anthropic content_block_delta /
// thinking_delta, OpenAI chat delta.content / delta.reasoning, OpenAI
// Responses output_text.delta / reasoning_summary_text.delta, Gemini
// candidates[].content.parts[].text.

export interface Turn {
  role: string;
  text: string;
  attachments?: string[];
  encrypted?: boolean;
  hiddenType?: string;
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

  appendInstructionTurn(turns, "system", o.system);
  appendInstructionTurn(turns, "system", o.instructions);
  appendInstructionTurn(turns, "system", o.systemInstruction);
  appendInstructionTurn(turns, "system", o.system_instruction);
  appendInstructionTurn(turns, "developer", o.developer);

  if (Array.isArray(o.messages)) {
    for (const m of o.messages) turns.push(messageToTurn(m));
  }
  if (Array.isArray(o.input)) {
    // OpenAI Responses input[] is a mixed list: messages, function_call,
    // function_call_output, reasoning, etc. Top-level non-message items
    // don't have role/content, so messageToTurn would render them as
    // "user (empty)". Hand them off to a dedicated converter.
    for (const m of o.input) turns.push(responsesInputToTurn(m));
  }
  if (Array.isArray(o.contents)) {
    for (const m of o.contents) turns.push(geminiContentToTurn(m));
  }

  return turns.length > 0 ? turns : null;
}

function appendInstructionTurn(turns: Turn[], role: string, raw: unknown) {
  const text = instructionToText(raw);
  if (text.trim()) turns.push({ role, text });
}

function instructionToText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw.map(instructionToText).filter(Boolean).join("\n");
  }
  if (!raw || typeof raw !== "object") return "";
  const o = raw as Record<string, unknown>;
  if (typeof o.text === "string") return o.text;
  if (typeof o.content === "string") return o.content;
  if (Array.isArray(o.content)) return o.content.map(instructionToText).filter(Boolean).join("\n");
  if (Array.isArray(o.parts)) return o.parts.map(instructionToText).filter(Boolean).join("\n");
  return "";
}

function messageToTurn(raw: unknown): Turn {
  const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const role = String(m.role || "user");
  const content = m.content ?? m.text;
  let text = "";
  const attachments: string[] = [];
  let imageCount = 0;

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
        } else if (hasEncryptedReasoning(p)) {
          append(hiddenTypeText(type));
        }
      } else if (type === "redacted_thinking") {
        append(hiddenTypeText(type));
      } else if (type === "tool_use") {
        const name = String(p.name || "tool");
        const input = JSON.stringify(p.input ?? {}, null, 2);
        append(`**[tool_use ${name}]**\n\n\`\`\`json\n${input}\n\`\`\``);
      } else if (type === "tool_result") {
        const id = p.tool_use_id ? ` ${p.tool_use_id}` : "";
        const result = toolResultContentToMarkdown(p.content, "tool result image");
        append(`**[tool_result${id}]**\n\n${result}`);
      } else if (isImagePartType(type)) {
        const md = imagePartToMarkdown(p, `image ${++imageCount}`);
        if (md) append(md);
        else attachments.push(describeImagePart(p));
      } else if (type) {
        attachments.push(type);
      }
    }
  } else if (content && typeof content === "object") {
    text = instructionToText(content);
  }

  return { role, text, attachments: attachments.length ? attachments : undefined };
}

function isImagePartType(type: string): boolean {
  return type === "image" || type === "input_image" || type === "image_url";
}

function toolResultContentToMarkdown(raw: unknown, imageLabel: string): string {
  if (typeof raw === "string") return fenceText(raw);
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    let imageCount = 0;
    for (const item of raw) {
      if (item && typeof item === "object") {
        const p = item as Record<string, unknown>;
        const type = String(p.type || "");
        if (isImagePartType(type)) {
          const md = imagePartToMarkdown(p, `${imageLabel} ${++imageCount}`);
          parts.push(md || `_${describeImagePart(p)}_`);
        } else if (typeof p.text === "string") {
          parts.push(fenceText(p.text));
        } else {
          parts.push(fenceText(JSON.stringify(p, null, 2)));
        }
      } else {
        parts.push(fenceText(String(item ?? "")));
      }
    }
    return parts.join("\n\n") || "_(empty)_";
  }
  return fenceText(JSON.stringify(raw ?? "", null, 2));
}

function fenceText(text: string): string {
  return codeFence(text);
}

function codeFence(text: string, language = ""): string {
  const longestTicks = Math.max(2, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const ticks = "`".repeat(longestTicks + 1);
  return `${ticks}${language}\n${text}\n${ticks}`;
}

function imagePartToMarkdown(part: Record<string, unknown>, alt: string): string | null {
  const url = imageURLFromPart(part)?.trim();
  if (!url || !isDisplayableImageURL(url)) return null;
  return `![${escapeMarkdownAlt(alt)}](${url})`;
}

function imageURLFromPart(part: Record<string, unknown>): string | null {
  const sourceURL = imageURLFromSource(part.source);
  if (sourceURL) return sourceURL;

  const imageURL = imageURLFromValue(part.image_url ?? part.imageUrl);
  if (imageURL) return imageURL;

  const inlineData = dataURLFromInlineData(part.inlineData ?? part.inline_data);
  if (inlineData) return inlineData;

  const mediaType = stringValue(part.media_type ?? part.mime_type ?? part.mimeType);
  const data = stringValue(part.data);
  if (mediaType && data) return dataToImageURL(mediaType, data);

  const url = stringValue(part.url);
  return url || null;
}

function imageURLFromSource(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const url = stringValue(source.url);
  if (url) return url;
  const mediaType = stringValue(source.media_type ?? source.mime_type ?? source.mimeType);
  const data = stringValue(source.data);
  return mediaType && data ? dataToImageURL(mediaType, data) : null;
}

function imageURLFromValue(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return stringValue(o.url) || null;
}

function dataURLFromInlineData(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const mediaType = stringValue(o.mimeType ?? o.mime_type ?? o.media_type);
  const data = stringValue(o.data);
  return mediaType && data ? dataToImageURL(mediaType, data) : null;
}

function dataToImageURL(mediaType: string, data: string): string | null {
  const trimmed = data.trim();
  if (trimmed.startsWith("data:")) return trimmed;
  const normalized = normalizeRasterMediaType(mediaType);
  if (!normalized) return null;
  const payload = trimmed.replace(/\s+/g, "");
  return isBase64Payload(payload) ? `data:${normalized};base64,${payload}` : null;
}

function isDisplayableImageURL(url: string): boolean {
  const trimmed = url.trim();
  return isSafeDataImageURL(trimmed) || /^https?:\/\//i.test(trimmed);
}

export function isSafeDataImageURL(url: string): boolean {
  const match = /^data:([^;,]+);base64,/i.exec(url);
  if (!match || !normalizeRasterMediaType(match[1])) return false;
  return isBase64Payload(url.slice(match[0].length));
}

function normalizeRasterMediaType(raw: string): string | null {
  const mediaType = raw.trim().toLowerCase();
  if (mediaType === "image/jpg") return "image/jpeg";
  if (
    mediaType === "image/png" ||
    mediaType === "image/jpeg" ||
    mediaType === "image/gif" ||
    mediaType === "image/webp"
  ) {
    return mediaType;
  }
  return null;
}

function isBase64Payload(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function describeImagePart(part: Record<string, unknown>): string {
  const fileID = stringValue(part.file_id ?? part.fileId);
  if (fileID) return `image file ${fileID}`;
  const mediaType = stringValue(
    (part.source as Record<string, unknown> | undefined)?.media_type ?? part.media_type,
  );
  return mediaType ? `image ${mediaType}` : "image";
}

function escapeMarkdownAlt(value: string): string {
  return value.replace(/[\[\]\r\n]+/g, " ").trim() || "image";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function hasEncryptedReasoning(o: Record<string, unknown>): boolean {
  return (
    typeof o.encrypted_content === "string" ||
    typeof o.signature === "string" ||
    typeof o.data === "string"
  );
}

function hiddenTypeText(type: string): string {
  return `_(${type})_`;
}

function markHidden(out: { encrypted?: boolean; hiddenType?: string }, type: string) {
  out.encrypted = true;
  if (!out.hiddenType) out.hiddenType = type;
}

// responsesInputToTurn handles the OpenAI Responses `input[]` mixed-item
// shape. Items with type=message fall back to messageToTurn; tool call
// and tool output items are rendered as their own assistant/tool
// turns so they don't show up as "user (empty)".
function responsesInputToTurn(raw: unknown): Turn {
  const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const type = String(m.type || "");
  if (type === "function_call") {
    const name = String(m.name || "tool");
    const args = typeof m.arguments === "string" ? m.arguments : JSON.stringify(m.arguments ?? {});
    const json = formatPartialJSON(args);
    return {
      role: "assistant",
      text: toolUseMarkdown(name, m.call_id, json, "json"),
    };
  }
  if (type === "custom_tool_call") {
    const name = String(m.name || "tool");
    const input = typeof m.input === "string" ? m.input : JSON.stringify(m.input ?? "", null, 2);
    return {
      role: "assistant",
      text: toolUseMarkdown(name, m.call_id, input, customToolLanguage(name, input)),
    };
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const out = typeof m.output === "string" ? m.output : JSON.stringify(m.output ?? "", null, 2);
    return {
      role: "tool",
      text: toolResultMarkdown(m.call_id, out),
    };
  }
  if (type === "reasoning") {
    const summary = Array.isArray(m.summary)
      ? m.summary
          .map((s) => (s && typeof s === "object" ? String((s as { text?: string }).text ?? "") : ""))
          .filter(Boolean)
          .join("\n")
      : "";
    if (summary) {
      const quoted = summary.split("\n").map((l) => "> " + l).join("\n");
      return { role: "assistant", text: "_thinking_\n" + quoted };
    }
    if (hasEncryptedReasoning(m)) {
      return { role: "assistant", text: hiddenTypeText(type), encrypted: true, hiddenType: type };
    }
    return { role: "assistant", text: "", attachments: ["reasoning"] };
  }
  // Default: messages, and anything else with a `role`+`content` shape.
  return messageToTurn(raw);
}

function toolUseMarkdown(name: string, rawCallID: unknown, input: string, language = ""): string {
  return `**[tool_use ${name}${callIDSuffix(rawCallID)}]**\n\n${codeFence(input, language)}`;
}

function toolResultMarkdown(rawCallID: unknown, output: string): string {
  return `**[tool_result${callIDSuffix(rawCallID)}]**\n\n${codeFence(output)}`;
}

function callIDSuffix(rawCallID: unknown): string {
  return rawCallID ? ` ${rawCallID}` : "";
}

function customToolLanguage(name: string, input: string): string {
  if (name === "apply_patch" || input.trimStart().startsWith("*** Begin Patch")) return "patch";
  return "";
}

function geminiContentToTurn(raw: unknown): Turn {
  const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const role = String(m.role || "user");
  const parts = Array.isArray(m.parts) ? m.parts : [];
  let text = "";
  const attachments: string[] = [];
  let imageCount = 0;
  const append = (chunk: string) => {
    if (!chunk) return;
    text += (text ? "\n\n" : "") + chunk;
  };

  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    if (typeof o.text === "string") {
      append(o.text);
      continue;
    }
    const md = imagePartToMarkdown(o, `image ${++imageCount}`);
    if (md) {
      append(md);
      continue;
    }
    if (o.inlineData) attachments.push("inline data");
    else if (o.functionCall) attachments.push(`function_call ${(o.functionCall as { name?: string })?.name || ""}`);
    else if (o.functionResponse) attachments.push("function_response");
    else attachments.push(Object.keys(o).join(",") || "part");
  }
  return { role, text, attachments: attachments.length ? attachments : undefined };
}


export interface StreamExtraction {
  detected: boolean;
  content: string;
  thinking: string;
  encrypted?: boolean;
  hiddenType?: string;
  errors: string[];
}

interface AnthropicBlock {
  index: number;
  type: string;
  name?: string;
  text: string;
  partialJSON: string;
  encrypted?: boolean;
  hiddenType?: string;
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

  // OpenAI Responses function_call items are streamed as
  // response.output_item.added (with name/call_id) followed by
  // response.function_call_arguments.delta chunks. Track them by
  // output_index and flush at the end so the user sees the actual tool call
  // even when the response contains no output_text.
  interface OpenAICall {
    name: string;
    callID: string;
    args: string;
    order: number;
    custom?: boolean;
  }
  const openAICalls = new Map<number, OpenAICall>();
  let openAICallOrder = 0;

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
      const type = String(block.type || "text");
      if (!blocks.has(idx)) blockOrder.push(idx);
      blocks.set(idx, {
        index: idx,
        type,
        name: typeof block.name === "string" ? block.name : undefined,
        text: "",
        partialJSON: "",
        encrypted: hasEncryptedReasoning(block),
        hiddenType: hasEncryptedReasoning(block) ? type : undefined,
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
      } else if (dt === "signature_delta" && typeof d.signature === "string") {
        if (b) markHidden(b, b.type || "thinking");
        else markHidden(out, "thinking");
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
      if (o.type === "response.function_call_arguments.delta" && typeof o.delta === "string") {
        const idx = typeof o.output_index === "number" ? (o.output_index as number) : -1;
        const call = openAICalls.get(idx);
        if (call) {
          call.args += o.delta;
        } else {
          openAICalls.set(idx, {
            name: "tool",
            callID: "",
            args: o.delta,
            order: openAICallOrder++,
          });
        }
      }
      if (o.type === "response.custom_tool_call_input.delta" && typeof o.delta === "string") {
        const idx = typeof o.output_index === "number" ? (o.output_index as number) : -1;
        const call = openAICalls.get(idx);
        if (call) {
          call.args += o.delta;
          call.custom = true;
        } else {
          openAICalls.set(idx, {
            name: "tool",
            callID: "",
            args: o.delta,
            order: openAICallOrder++,
            custom: true,
          });
        }
      }
    }
    if (o.type === "response.output_item.added") {
      const item = (o.item as Record<string, unknown>) || {};
      if (item.type === "function_call") {
        const idx = typeof o.output_index === "number" ? (o.output_index as number) : -1;
        const existing = openAICalls.get(idx);
        const partial = typeof item.arguments === "string" ? (item.arguments as string) : "";
        openAICalls.set(idx, {
          name: typeof item.name === "string" ? (item.name as string) : existing?.name || "tool",
          callID: typeof item.call_id === "string" ? (item.call_id as string) : existing?.callID || "",
          args: (existing?.args || "") + partial,
          order: existing?.order ?? openAICallOrder++,
        });
      } else if (item.type === "custom_tool_call") {
        const idx = typeof o.output_index === "number" ? (o.output_index as number) : -1;
        const existing = openAICalls.get(idx);
        const partial = typeof item.input === "string" ? (item.input as string) : "";
        openAICalls.set(idx, {
          name: typeof item.name === "string" ? (item.name as string) : existing?.name || "tool",
          callID: typeof item.call_id === "string" ? (item.call_id as string) : existing?.callID || "",
          args: (existing?.args || "") + partial,
          order: existing?.order ?? openAICallOrder++,
          custom: true,
        });
      } else if (item.type === "reasoning" && hasEncryptedReasoning(item)) {
        markHidden(out, "reasoning");
      }
    }
    if (o.type === "response.output_item.done") {
      const item = (o.item as Record<string, unknown>) || {};
      const idx = typeof o.output_index === "number" ? (o.output_index as number) : -1;
      const existing = openAICalls.get(idx);
      if (item.type === "function_call" || item.type === "custom_tool_call") {
        const input =
          item.type === "custom_tool_call"
            ? stringValue(item.input)
            : stringValue(item.arguments);
        openAICalls.set(idx, {
          name: stringValue(item.name) || existing?.name || "tool",
          callID: stringValue(item.call_id) || existing?.callID || "",
          args: input || existing?.args || "",
          order: existing?.order ?? openAICallOrder++,
          custom: item.type === "custom_tool_call" || existing?.custom,
        });
      }
    }
    if (o.type === "response.function_call_arguments.done") {
      const idx = typeof o.output_index === "number" ? (o.output_index as number) : -1;
      const call = openAICalls.get(idx);
      if (call && typeof o.arguments === "string" && (o.arguments as string).length > call.args.length) {
        call.args = o.arguments as string;
      }
    }
    if (o.type === "response.custom_tool_call_input.done") {
      const idx = typeof o.output_index === "number" ? (o.output_index as number) : -1;
      const call = openAICalls.get(idx);
      if (call && typeof o.input === "string" && (o.input as string).length > call.args.length) {
        call.args = o.input as string;
        call.custom = true;
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
      if (b.text) out.thinking += b.text;
      else if (b.encrypted) markHidden(out, b.hiddenType || b.type);
    } else if (b.type === "redacted_thinking") {
      markHidden(out, b.hiddenType || b.type);
    } else if (b.type === "tool_use") {
      const json = formatPartialJSON(b.partialJSON);
      const name = b.name || "tool";
      const sep = out.content ? "\n\n" : "";
      out.content += sep + toolUseMarkdown(name, undefined, json, "json");
    }
  }

  // Flush OpenAI Responses tool call items in arrival order.
  const calls = Array.from(openAICalls.values()).sort((a, b) => a.order - b.order);
  for (const c of calls) {
    const input = c.custom ? c.args : formatPartialJSON(c.args);
    const language = c.custom ? customToolLanguage(c.name, input) : "json";
    const sep = out.content ? "\n\n" : "";
    out.content += sep + toolUseMarkdown(c.name, c.callID, input, language);
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
      } else if (p.type === "thinking" && typeof p.thinking === "string" && p.thinking) {
        out.thinking += p.thinking;
        out.detected = true;
      } else if (p.type === "thinking" && hasEncryptedReasoning(p)) {
        markHidden(out, "thinking");
        out.detected = true;
      } else if (p.type === "redacted_thinking") {
        markHidden(out, "redacted_thinking");
        out.detected = true;
      } else if (p.type === "tool_use") {
        const name = String(p.name || "tool");
        const input = JSON.stringify(p.input ?? {}, null, 2);
        const sep = out.content ? "\n\n" : "";
        out.content += `${sep}**[tool_use ${name}]**\n\n\`\`\`json\n${input}\n\`\`\``;
        out.detected = true;
      } else if (isImagePartType(String(p.type || ""))) {
        const md = imagePartToMarkdown(p, "image");
        if (md) {
          appendResponseMarkdown(out, md);
          out.detected = true;
        }
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
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part || typeof part !== "object") continue;
          const p = part as Record<string, unknown>;
          if ((p.type === "text" || p.type === "output_text") && typeof p.text === "string") {
            appendResponseMarkdown(out, p.text);
            out.detected = true;
          } else if (isImagePartType(String(p.type || ""))) {
            const md = imagePartToMarkdown(p, "image");
            if (md) {
              appendResponseMarkdown(out, md);
              out.detected = true;
            }
          }
        }
      }
      if (typeof msg.reasoning === "string" && msg.reasoning) {
        out.thinking += msg.reasoning;
        out.detected = true;
      } else if (hasEncryptedReasoning(msg)) {
        markHidden(out, "reasoning");
        out.detected = true;
      }
    }
  }

  // OpenAI Responses non-streaming: { output: [ { type:'message', content:[...]}, { type:'function_call', name, arguments, call_id } ] }
  if (Array.isArray(o.output)) {
    for (const item of o.output) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      if (it.type === "function_call") {
        const name = String(it.name || "tool");
        const args = typeof it.arguments === "string" ? (it.arguments as string) : JSON.stringify(it.arguments ?? {});
        const json = formatPartialJSON(args);
        const sep = out.content ? "\n\n" : "";
        out.content += sep + toolUseMarkdown(name, it.call_id, json, "json");
        out.detected = true;
        continue;
      }
      if (it.type === "custom_tool_call") {
        const name = String(it.name || "tool");
        const input = typeof it.input === "string" ? it.input : JSON.stringify(it.input ?? "", null, 2);
        const sep = out.content ? "\n\n" : "";
        out.content += sep + toolUseMarkdown(name, it.call_id, input, customToolLanguage(name, input));
        out.detected = true;
        continue;
      }
      if (it.type === "function_call_output" || it.type === "custom_tool_call_output") {
        const output = typeof it.output === "string" ? it.output : JSON.stringify(it.output ?? "", null, 2);
        const sep = out.content ? "\n\n" : "";
        out.content += sep + toolResultMarkdown(it.call_id, output);
        out.detected = true;
        continue;
      }
      if (it.type === "image_generation_call" && typeof it.result === "string") {
        const mimeType = stringValue(it.mime_type ?? it.media_type) || "image/png";
        const url = dataToImageURL(mimeType, it.result);
        if (url) {
          appendResponseMarkdown(out, `![generated image](${url})`);
          out.detected = true;
        }
        continue;
      }
      if (it.type === "reasoning") {
        const summary = Array.isArray(it.summary)
          ? it.summary
              .map((s) => (s && typeof s === "object" ? String((s as { text?: string }).text ?? "") : ""))
              .filter(Boolean)
              .join("\n")
          : "";
        if (summary) {
          out.thinking += (out.thinking ? "\n" : "") + summary;
          out.detected = true;
        } else if (hasEncryptedReasoning(it)) {
          markHidden(out, "reasoning");
          out.detected = true;
        }
        continue;
      }
      const c = it.content;
      if (Array.isArray(c)) {
        for (const part of c) {
          if (!part || typeof part !== "object") continue;
          const p = part as Record<string, unknown>;
          if ((p.type === "output_text" || p.type === "text") && typeof p.text === "string") {
            out.content += p.text;
            out.detected = true;
          } else if (isImagePartType(String(p.type || ""))) {
            const md = imagePartToMarkdown(p, "image");
            if (md) {
              appendResponseMarkdown(out, md);
              out.detected = true;
            }
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

function appendResponseMarkdown(out: StreamExtraction, chunk: string) {
  if (!chunk) return;
  out.content += (out.content ? "\n\n" : "") + chunk;
}

// turnsToMarkdown renders a list of conversation turns as a single markdown
// document with each role as a badge.
export function turnsToMarkdown(turns: Turn[]): string {
  return turns
    .map((t) => {
      let out = `**@role:${t.role}**\n\n${t.text || hiddenTypeFallback(t) || "_(empty)_"}`;
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
  } else if (s.hiddenType) {
    parts.push("**Thinking**\n\n" + hiddenTypeText(s.hiddenType));
  }
  if (s.content.trim()) {
    parts.push(s.content);
  }
  if (s.errors.length) {
    parts.push("**Errors**\n\n" + s.errors.map((e) => "- " + e).join("\n"));
  }
  return parts.join("\n\n---\n\n") || "_(empty)_";
}

function hiddenTypeFallback(value: { encrypted?: boolean; hiddenType?: string }): string {
  return value.hiddenType ? hiddenTypeText(value.hiddenType) : "";
}
