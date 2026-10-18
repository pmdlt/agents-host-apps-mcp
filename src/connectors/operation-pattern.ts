// Excerpt from a private codebase, shared for the Make Something Agents Want hackathon (README.md).
// Imports that point outside this folder are not included, so this does not build on its own.

// The grammar of an operation pattern (`"<METHOD|*> /path"`), which every
// policy list of a connector entry is written in, and of an operation key
// (`featured`), which is the same grammar without wildcards.
//
// It lives apart from the entry format (entry-schema.ts) because two kinds of
// code read it. The entry format validates entries with zod, and builds its
// schemas when it loads, which is why only a deferred module may reach it
// (scripts/check-startup.mjs). The spec pipeline (src/connectors/spec/) ranks
// an index's featured operations by these patterns, and is pure and light, so
// that the index run, the simulator and the lab harness can all import it.
// This module is the part both need: plain functions over strings, no zod, no
// imports. entry-schema.ts re-exports it, so an entry's reader still finds
// everything about the format in one place.

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

type PatternSegment =
  | { kind: "literal"; value: string }
  | { kind: "param" }
  | { kind: "one" }
  | { kind: "rest" };

export interface OperationPattern {
  method: HttpMethod | "*";
  segments: readonly PatternSegment[];
}

const LITERAL_SEGMENT = /^[A-Za-z0-9._~-]+$/;
/** A whole-segment path parameter, as a pattern writes one: `{project}`. */
const PARAM_SEGMENT = /^\{[A-Za-z0-9_.-]{1,64}\}$/;
/**
 * A whole-segment path parameter in a spec's path template, whatever the spec
 * calls it: OpenAPI puts no limit on a parameter's name, and a template
 * segment the pattern side could not name must still count as one.
 */
const TEMPLATE_PARAM_SEGMENT = /^\{[^{}/]+\}$/;

/** What a pattern looks like before its segments are read: the entry format's regex. */
export const OPERATION_PATTERN = /^(GET|POST|PUT|PATCH|DELETE|\*) (\/\S{0,255})$/;

/**
 * Reads `"<METHOD> <path>"`, the form every policy list uses. `<METHOD>` is one
 * method or `*` for any. Each path segment is a literal, a `{name}` that
 * matches any path parameter (whatever the spec calls it, since a parameter
 * renamed between versions is the same route), `*` for any one segment, or a
 * final `**` for any number of them, none included. The path is the
 * operation's full path, with the `servers` prefix the spec declares.
 *
 * One trailing slash may be written and means nothing: a pattern matches a
 * route with or without one (`operationMatches`), so a pattern copied from a
 * spec whose every path ends in `/` names the route it was copied from.
 *
 * `wildcards: false` is the form of an operation key (`featured`): one method,
 * and no `*` or `**`.
 */
export function parseOperationPattern(
  text: string,
  { wildcards = true }: { wildcards?: boolean } = {},
): OperationPattern | null {
  const match = OPERATION_PATTERN.exec(text);
  if (!match) return null;
  const method = match[1] as HttpMethod | "*";
  if (method === "*" && !wildcards) return null;
  const path = match[2]!;
  if (path === "/") return { method, segments: [] };
  const raw = withoutTrailingSlash(path).split("/").slice(1);
  const segments: PatternSegment[] = [];
  for (const [i, segment] of raw.entries()) {
    if (segment === "**" && wildcards && i === raw.length - 1) {
      segments.push({ kind: "rest" });
    } else if (segment === "*" && wildcards) {
      segments.push({ kind: "one" });
    } else if (PARAM_SEGMENT.test(segment)) {
      segments.push({ kind: "param" });
    } else if (LITERAL_SEGMENT.test(segment) && segment !== "." && segment !== "..") {
      segments.push({ kind: "literal", value: segment });
    } else {
      return null;
    }
  }
  return { method, segments };
}

/**
 * Does an operation (its method, and its path template with the `servers`
 * prefix) fall under `pattern`? A template segment counts as a parameter when
 * the whole segment is one, whatever its name (`{id}`, `{user id}`);
 * `{id}.json` is matched as written. A trailing slash on the template is
 * ignored, as on the pattern.
 *
 * Every policy list only tightens, so a pattern that misses the route it was
 * written for is a rule that silently does not apply. Where the reading is in
 * doubt (a slash, a parameter's spelling), this matches more, never less.
 */
export function operationMatches(
  pattern: OperationPattern,
  method: string,
  pathTemplate: string,
): boolean {
  if (pattern.method !== "*" && pattern.method !== method.toUpperCase()) return false;
  const template =
    pathTemplate === "/" ? [] : withoutTrailingSlash(pathTemplate).split("/").slice(1);
  for (const [i, segment] of pattern.segments.entries()) {
    if (segment.kind === "rest") return true;
    const actual = template[i];
    if (actual === undefined) return false;
    if (segment.kind === "literal" && actual !== segment.value) return false;
    if (segment.kind === "param" && !TEMPLATE_PARAM_SEGMENT.test(actual)) return false;
  }
  return template.length === pattern.segments.length;
}

/** `/a/b/` as `/a/b`; a path with no trailing slash, or the root, unchanged. */
function withoutTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}
