// Shared helpers for the T7 document / deploy tests.
const VOID = new Set(['meta', 'br', 'img', 'hr', 'input', 'link', 'line', 'rect', 'path', 'polyline', 'polygon', 'circle']);

/** Returns '' when every non-void element is closed in order, else a short description of the first problem. */
export function tagBalance(html: string): string {
  const src = html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/src="data:[^"]*"/g, '');
  const stack: string[] = [];
  for (const m of src.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g)) {
    const [, close, tagRaw, self] = m;
    const tag = tagRaw.toLowerCase();
    if (self || VOID.has(tag)) continue;
    if (!close) stack.push(tag);
    else {
      const top = stack.pop();
      if (top !== tag) return `</${tag}> closes <${top}> at ${m.index}`;
    }
  }
  return stack.length ? `unclosed: ${stack.slice(-5).join(',')}` : '';
}

/** Text without data URIs (drawing figures embed arbitrary SVG text). */
export const withoutDataUris = (s: string) => s.replace(/src="data:[^"]*"/g, '');
