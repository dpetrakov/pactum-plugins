// JSON and JSONC with positions (W-06c, file-types.md §5; choice — architecture.md §17): a small recursive-descent
// parser giving the offset and length of every node, the comments (JSONC) and the first error with its offset.
// Strict JSON (RFC 8259) for .json; JSONC adds // and /* */ comments and trailing commas (tsconfig, VS Code).
// No code is executed; nesting is bounded by MAX_NESTING (a deeper document is an error, not a stack overflow).

export interface JsonNode {
  type: "object" | "array" | "property" | "string" | "number" | "boolean" | "null";
  offset: number;
  length: number;
  /** Decoded string, number (as JS number; the source text is kept by the caller), boolean or null. */
  value?: string | number | boolean | null;
  children?: JsonNode[];
}

export interface JsonParse {
  root: JsonNode | null;
  error: { offset: number; message: string } | null;
  comments: { start: number; end: number }[];
}

export const MAX_NESTING = 512;

class Failure extends Error {
  readonly offset: number;
  constructor(offset: number, message: string) {
    super(message);
    this.offset = offset;
  }
}

export function parseJsonTree(text: string, options: { comments: boolean }): JsonParse {
  let i = 0;
  const n = text.length;
  const comments: { start: number; end: number }[] = [];
  const fail = (message: string, at = i): never => { throw new Failure(at, message); };

  const skip = () => {
    for (;;) {
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xfeff) i++;
        else break;
      }
      if (text.charCodeAt(i) === 47 /* / */ && (text.charCodeAt(i + 1) === 47 || text.charCodeAt(i + 1) === 42)) {
        if (!options.comments) fail("comments are not allowed in JSON");
        const start = i;
        if (text.charCodeAt(i + 1) === 47) {
          const nl = text.indexOf("\n", i);
          i = nl < 0 ? n : nl;
        } else {
          const close = text.indexOf("*/", i + 2);
          if (close < 0) fail("unterminated comment");
          i = close + 2;
        }
        comments.push({ start, end: i });
        continue;
      }
      return;
    }
  };

  const string = (): JsonNode => {
    const start = i;
    i++;
    let out = "";
    let run = i;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 34) {
        out += text.slice(run, i);
        i++;
        return { type: "string", offset: start, length: i - start, value: out };
      }
      if (c === 92) {
        out += text.slice(run, i);
        const e = text[i + 1];
        const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (e in simple) { out += simple[e]; i += 2; }
        else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6; }
        else fail("invalid escape in string");
        run = i;
        continue;
      }
      if (c < 32) fail("control character in string");
      i++;
    }
    return fail("unterminated string", start);
  };

  const number = (): JsonNode => {
    const start = i;
    const match = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    match.lastIndex = i;
    const m = match.exec(text);
    if (!m) fail("invalid number");
    i += m![0].length;
    return { type: "number", offset: start, length: i - start, value: Number(m![0]) };
  };

  const value = (depth: number): JsonNode => {
    if (depth > MAX_NESTING) fail("nesting too deep");
    skip();
    const c = text[i];
    if (c === "{") return object(depth);
    if (c === "[") return array(depth);
    if (c === '"') return string();
    if (c === "-" || (c >= "0" && c <= "9")) return number();
    for (const [word, v] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, i)) {
        const start = i;
        i += word.length;
        return { type: v === null ? "null" : "boolean", offset: start, length: word.length, value: v };
      }
    }
    return fail(i >= n ? "unexpected end of file" : "value expected");
  };

  const object = (depth: number): JsonNode => {
    const start = i;
    i++;
    const children: JsonNode[] = [];
    skip();
    if (text[i] === "}") { i++; return { type: "object", offset: start, length: i - start, children }; }
    for (;;) {
      skip();
      if (text[i] !== '"') {
        if (text[i] === "}" && options.comments && children.length) { i++; break; }
        fail("property name expected");
      }
      const key = string();
      skip();
      if (text[i] !== ":") fail("colon expected");
      i++;
      const v = value(depth + 1);
      children.push({ type: "property", offset: key.offset, length: v.offset + v.length - key.offset, children: [key, v] });
      skip();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "}") { i++; break; }
      fail("comma expected");
    }
    return { type: "object", offset: start, length: i - start, children };
  };

  const array = (depth: number): JsonNode => {
    const start = i;
    i++;
    const children: JsonNode[] = [];
    skip();
    if (text[i] === "]") { i++; return { type: "array", offset: start, length: i - start, children }; }
    for (;;) {
      skip();
      if (text[i] === "]" && options.comments && children.length) { i++; break; }
      children.push(value(depth + 1));
      skip();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "]") { i++; break; }
      fail("comma expected");
    }
    return { type: "array", offset: start, length: i - start, children };
  };

  try {
    const root = value(0);
    skip();
    if (i < n) fail("end of file expected");
    return { root, error: null, comments };
  } catch (error) {
    if (error instanceof Failure) return { root: null, error: { offset: error.offset, message: error.message }, comments };
    throw error;
  }
}
