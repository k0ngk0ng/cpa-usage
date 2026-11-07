import { useMemo, useState } from "react";
import type { EventLogEntry } from "../api/types";
import { displayableGeneratedImageURLFromPart, displayableImageURLFromPart } from "../lib/protocol";
import { responseBodyContent } from "../lib/sessionContent";

type RecordValue = Record<string, unknown>;
interface Picture { url?: string; name: string; field?: string; revisedPrompt?: string; }

export function isImageEndpoint(endpoint = ""): boolean {
  try { return /\/images\/(?:edits|generations|variations)\/?$/.test(new URL(endpoint, "http://log.local").pathname); }
  catch { return false; }
}

function object(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}
function parse(raw: string): RecordValue | null {
  try { return object(JSON.parse(raw)); } catch { return null; }
}

function inputReference(value: unknown, field: string, index: number): Picture {
  const ref = object(value) || { image_url: value };
  return { name: String(ref.file_id || ref.filename || `${field} ${index + 1}`), field, url: displayableImageURLFromPart(ref) || undefined };
}

function requestContent(entry: EventLogEntry) {
  if (entry.image_request) return {
    fields: entry.image_request.fields,
    pictures: entry.image_request.files.map(file => ({ name: file.filename, field: file.name.replace(/\[\]$/, ""), url: file.url })),
  };
  const request = parse(entry.request_body);
  if (!request) return null;
  const fields = Object.entries(request).filter(([name, value]) => !["image", "images", "mask", "markup"].includes(name) && ["string", "number", "boolean"].includes(typeof value)).map(([name, value]) => ({ name, value: String(value) }));
  const pictures: Picture[] = [];
  const images = request.images ?? request.image;
  for (const [index, image] of (Array.isArray(images) ? images : images ? [images] : []).entries()) pictures.push(inputReference(image, "image", index));
  for (const field of ["mask", "markup"]) if (request[field]) pictures.push(inputReference(request[field], field, 0));
  return { fields, pictures };
}

function responseContent(raw: string) {
  const body = responseBodyContent(raw);
  const direct = parse(body);
  const events = direct ? [direct] : body.split(/\r?\n/).flatMap(line => {
    if (!line.startsWith("data:")) return [];
    const event = parse(line.slice(5).trim()); return event ? [event] : [];
  });
  let pictures: Picture[] = [], partial: Picture[] = [], error = "", completed = false;
  const convert = (item: RecordValue, format: unknown, index: number): Picture | null => {
    const url = typeof item.b64_json === "string"
      ? displayableGeneratedImageURLFromPart({ result: item.b64_json, output_format: item.output_format || format })
      : displayableImageURLFromPart(item);
    if (!url) return null;
    const extension = String(item.output_format || format || "png").replace(/[^a-z0-9]/gi, "");
    return { url, name: `generated-${index + 1}.${extension}`, revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined };
  };
  for (const event of events) {
    const failure = object(event.error);
    if (failure || event.type === "error") error = String(failure?.message || event.message || "Image generation failed");
    if (Array.isArray(event.data)) {
      pictures = event.data.flatMap((item, index) => { const image = object(item); const picture = image && convert(image, event.output_format, index); return picture ? [picture] : []; });
      completed = true;
    } else if (/^image_(?:generation|edit)\.completed$/.test(String(event.type))) {
      const picture = convert(event, event.output_format, 0); pictures = picture ? [picture] : []; completed = true;
    } else if (/^image_(?:generation|edit)\.partial_image$/.test(String(event.type))) {
      const picture = convert(event, event.output_format, 0); partial = picture ? [picture] : [];
    }
  }
  return { pictures: completed ? pictures : partial, partial: !completed && partial.length > 0, error };
}

function downloadURL(url: string): string {
  if (!url.startsWith("/") || url.startsWith("//")) return url;
  const parsed = new URL(url, "http://log.local");
  if (parsed.pathname.endsWith("/log/asset")) parsed.searchParams.set("download", "1");
  return parsed.pathname + parsed.search;
}

function PictureGrid({ pictures }: { pictures: Picture[] }) {
  return <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{pictures.map((picture, index) => <ImagePreview key={`${picture.url || picture.name}-${index}`} picture={picture} />)}</div>;
}

function ImagePreview({ picture }: { picture: Picture }) {
  const [failed, setFailed] = useState(false);
  return <figure className="min-w-0 overflow-hidden rounded border border-border bg-panel">
    {picture.url && !failed ? <img src={picture.url} alt={picture.name} className="block max-h-[460px] w-full object-contain" loading="lazy" onError={() => setFailed(true)} /> : <p className="p-4 text-xs text-muted">{failed ? "Unable to load image." : "Preview unavailable"}</p>}
    <figcaption className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs">
      <span className="min-w-0 break-words">{picture.field && picture.field !== "image" ? `${picture.field} · ` : ""}{picture.name}</span>
      {picture.url && <a href={downloadURL(picture.url)} download={picture.name} className="shrink-0 text-accent hover:underline">Download</a>}
    </figcaption>
    {picture.revisedPrompt && <p className="whitespace-pre-wrap break-words border-t border-border p-3 text-xs">{picture.revisedPrompt}</p>}
  </figure>;
}

export function ImageRequestView({ entry }: { entry: EventLogEntry }) {
  const content = useMemo(() => requestContent(entry), [entry]);
  if (!content) return <pre className="whitespace-pre-wrap break-words text-xs">{entry.request_body}</pre>;
  const prompt = content.fields.filter(field => field.name === "prompt");
  const parameters = content.fields.filter(field => field.name !== "prompt");
  return <section data-image-request aria-label="Image request" className="space-y-4">
    {prompt.map((field, index) => <p key={index} className="whitespace-pre-wrap break-words text-sm leading-relaxed">{field.value}</p>)}
    {parameters.length > 0 && <dl className="flex flex-wrap gap-x-6 gap-y-2 text-xs">{parameters.map((field, index) => <div key={index}><dt className="text-muted">{field.name}</dt><dd className="break-all font-mono">{field.value}</dd></div>)}</dl>}
    {content.pictures.length > 0 && <PictureGrid pictures={content.pictures} />}
    <details><summary className="cursor-pointer text-xs text-muted">Raw request</summary><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all text-[11px]">{entry.request_body}</pre></details>
  </section>;
}

export function ImageResponseView({ raw }: { raw: string }) {
  const result = useMemo(() => responseContent(raw), [raw]);
  return <section data-image-response aria-label="Generated images" className="space-y-4">
    {result.error && <p className="text-sm text-danger">{result.error}</p>}
    {result.partial && <p className="text-xs text-muted">Partial image · completion not recorded</p>}
    <PictureGrid pictures={result.pictures} />
    {!result.pictures.length && !result.error && <p className="text-xs text-muted">No image result recorded.</p>}
    <details><summary className="cursor-pointer text-xs text-muted">Raw response</summary><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all text-[11px]">{raw}</pre></details>
  </section>;
}

export function ImageFinalView({ entry, response }: { entry: EventLogEntry; response: string }) {
  return <div className="space-y-6"><div><h3 className="mb-3 text-sm font-semibold">Input</h3><ImageRequestView entry={entry} /></div><div className="border-t border-border pt-5"><h3 className="mb-3 text-sm font-semibold">Output</h3><ImageResponseView raw={response} /></div></div>;
}
