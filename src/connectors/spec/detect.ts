// Excerpt from a private codebase, shared for the Make Something Agents Want hackathon (README.md).
// Imports that point outside this folder are not included, so this does not build on its own.

// Which documents the operation index reads at all: OpenAPI 3.0 and 3.1, as
// JSON, and nothing else (app-connectors PLAN §5 R2, §10 Q9).
//
// An app's spec is the first thing in the index that the app wrote, and it is
// read by a workflow step with a memory and CPU budget of its own. So the
// refusals here are cheap and happen first, before anything walks the
// document: a text past the size the spec fetch accepts, a text that is not
// JSON, a document that is not OpenAPI 3.0 or 3.1. Swagger 2 and YAML are
// deferred (PLAN §1 "Not in v1"); they are refused by name rather than
// guessed at, so a spec Pilae cannot read says so instead of indexing as an
// app with no operations.
//
// Errors carry a code from a fixed set and Pilae's own words. A message never
// quotes the document: whatever the app put in its spec is not for logs, and
// `lastIndexError` (R5) keeps only the code.

/**
 * The largest spec read, in UTF-8 bytes: the spec fetch's own cap
 * (`MESH_PROFILES.spec.maxResponseBytes` in src/gateway/fetch.ts, which a test
 * holds this to). A document handed over some other way (the simulator, the
 * lab harness) is held to the same number, so every path refuses the same
 * specs.
 */
export const MAX_SPEC_BYTES = 5 * 1024 * 1024;

export type SpecErrorCode =
  /** Not OpenAPI 3.0 or 3.1 JSON: YAML, Swagger 2, OpenAPI 3.2, or not a spec at all. */
  | "SPEC_UNSUPPORTED"
  /**
   * Past a budget: the text's size, the number of operations, the work of
   * resolving its schemas, or the bytes of schema one index may store.
   */
  | "SPEC_TOO_LARGE";

/**
 * Why a spec was not indexed. `detail` names which budget or which rule, from
 * a fixed vocabulary, with the numbers that were measured: for logs and tests,
 * never the document's own text.
 */
export class SpecError extends Error {
  readonly code: SpecErrorCode;
  readonly detail: Readonly<Record<string, string | number>>;
  constructor(code: SpecErrorCode, message: string, detail: Record<string, string | number> = {}) {
    super(message);
    this.name = "SpecError";
    this.code = code;
    this.detail = detail;
  }
}

export interface DetectedSpec {
  /** The `openapi` field as written, `3.1.0` say. */
  openapi: string;
  /** The minor line, which decides how `$ref` siblings are read (resolve.ts). */
  version: "3.0" | "3.1";
  doc: Readonly<Record<string, unknown>>;
}

/**
 * A spec read from its text by `parseSpec`, which measured it: the only kind
 * of parsed document the pipeline builds an index from (build.ts), so a
 * caller that parsed the text once, to check an entry's `match.spec` say,
 * passes this rather than parsing it again, and cannot pass a document that
 * skipped the size check.
 */
export interface ParsedSpec extends DetectedSpec {
  /** The text's size in UTF-8 bytes, at most `MAX_SPEC_BYTES`. */
  bytes: number;
}

/** `3.0.x` and `3.1.x`, patch any: the two lines v1 reads. */
const SUPPORTED = /^3\.([01])\.\d{1,4}$/;

/**
 * Read a spec's text: size first, then JSON, then the version.
 *
 * Size is measured in UTF-8 bytes, as the fetch measured it. A leading
 * byte-order mark is dropped, since some servers write one and `JSON.parse`
 * refuses it. Anything `JSON.parse` refuses is `SPEC_UNSUPPORTED` with
 * `detail.format: "not_json"`, which is how YAML arrives.
 */
export function parseSpec(text: string): ParsedSpec {
  const bytes = utf8Length(text);
  if (bytes > MAX_SPEC_BYTES) {
    throw new SpecError("SPEC_TOO_LARGE", "the spec is larger than Pilae reads", {
      budget: "spec_bytes",
      bytes,
      limit: MAX_SPEC_BYTES,
    });
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new SpecError("SPEC_UNSUPPORTED", "the spec is not JSON", { format: "not_json" });
  }
  return { ...detectSpec(doc), bytes };
}

/**
 * Check an already parsed document: an object whose `openapi` is a 3.0 or 3.1
 * version string. A `swagger` field says Swagger 2 (`detail.format:
 * "swagger_2"`); any other `openapi` is `detail.format: "openapi_version"`.
 * Whether it has paths at all is not this function's question: a 3.1 document
 * may hold only components, and indexes as no operations.
 */
export function detectSpec(doc: unknown): DetectedSpec {
  if (!isRecord(doc)) {
    throw new SpecError("SPEC_UNSUPPORTED", "the spec is not a JSON object", {
      format: "not_object",
    });
  }
  if (Object.hasOwn(doc, "swagger")) {
    throw new SpecError("SPEC_UNSUPPORTED", "Swagger 2 specs are not read yet", {
      format: "swagger_2",
    });
  }
  const openapi = doc.openapi;
  const match = typeof openapi === "string" ? SUPPORTED.exec(openapi) : null;
  if (!match || typeof openapi !== "string") {
    throw new SpecError("SPEC_UNSUPPORTED", "only OpenAPI 3.0 and 3.1 specs are read", {
      format: "openapi_version",
    });
  }
  return { openapi, version: match[1] === "0" ? "3.0" : "3.1", doc };
}

/** UTF-8 length without encoding the whole text into a second buffer. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
