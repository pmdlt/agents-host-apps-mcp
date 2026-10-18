// Excerpt from a private codebase, shared for the Make Something Agents Want hackathon (README.md).
// Imports that point outside this folder are not included, so this does not build on its own.

// What a person accepts when an operation is accepted, and how a later version
// of it compares (PLAN §5 R2, and R5's serving table).
//
// An acceptance (`connector_operation_accept`) is the only baseline review
// has: the first index accepts every operation that is not denied, an admin
// accepts the rest one by one, and from then on each re-index asks of each
// operation whether the shape it has now lets the agent do more than the shape
// someone accepted. Not whether anything changed: an app that fixes a typo in
// a summary, adds a response field or drops a filter must not send anyone
// back to the review screen. So the fingerprint holds only what bounds a
// call's power:
//
//  - `cls`: the class it is called under, read, write, destructive or deny;
//  - `req`: every argument it cannot be called without, by location
//    (`path:task`, `query:filter`, `header:if-match`, `body`, `body:title`);
//  - `q`, `h`, `body`: every query parameter, header parameter and top-level
//    body property it can be called with;
//  - `b`: what its body can carry. `none`, no body; `closed`, the properties
//    in `body` and nothing else; `open`, any field (a schema with no
//    properties, or one that does not forbid others); `upload`, a body Pilae
//    cannot send, so an operation that is never served. Property names alone
//    cannot say this: an operation that gains a free-form body, or whose body
//    stops forbidding unknown fields, lists the same names as before.
//
// Its JSON is canonical: the keys in that order, each list sorted (by UTF-16
// code unit) and without repeats, so two fingerprints of the same shape are
// the same text and a stored one compares as text. `v` is the format's
// version; a fingerprint of any other version, or of no recognisable shape,
// compares as never accepted, which is the safe reading of a baseline nobody
// can interpret.

import type { OperationClass } from "../store";
import type { OperationBody, OperationParam } from "./operations";

/** What an operation's body can carry, from least to most. */
export const BODY_REACHES = ["none", "closed", "open", "upload"] as const;
export type BodyReach = (typeof BODY_REACHES)[number];

export interface OperationFingerprint {
  v: 1;
  cls: OperationClass;
  req: string[];
  q: string[];
  h: string[];
  body: string[];
  b: BodyReach;
}

export interface FingerprintableOperation {
  policyClass: OperationClass;
  params: readonly Pick<OperationParam, "name" | "in" | "required">[];
  body: Pick<OperationBody, "required" | "props" | "requiredProps" | "closed"> | null;
  upload: boolean;
}

export function fingerprintOf(op: FingerprintableOperation): OperationFingerprint {
  const req: string[] = [];
  const q: string[] = [];
  const h: string[] = [];
  for (const param of op.params) {
    const name = param.in === "header" ? param.name.toLowerCase() : param.name;
    if (param.in === "query") q.push(name);
    if (param.in === "header") h.push(name);
    if (param.required || param.in === "path") req.push(`${param.in}:${name}`);
  }
  if (op.body?.required) req.push("body");
  for (const prop of op.body?.requiredProps ?? []) req.push(`body:${prop}`);
  return {
    v: 1,
    cls: op.policyClass,
    req: canonical(req),
    q: canonical(q),
    h: canonical(h),
    body: canonical(op.body?.props ?? []),
    b: op.upload ? "upload" : !op.body ? "none" : op.body.closed ? "closed" : "open",
  };
}

/**
 * How the current shape compares with the accepted one, from the most to the
 * least serious, so the first that applies is the answer:
 *
 * | answer     | when                                                      | the operation is |
 * |------------|-----------------------------------------------------------|------------------|
 * | `new`      | nothing usable was accepted: no baseline, or an upload    | held             |
 * |            | (never served) that now has a body Pilae sends, or none   |                  |
 * | `required` | a required argument was removed or made optional          | held             |
 * | `class`    | its class is less severe than the one accepted            | widened          |
 * | `params`   | an optional query or header parameter, or body property,  | widened          |
 * |            | was added; or its body reaches further (`b`): a body      |                  |
 * |            | where there was none, an open one where it was closed     |                  |
 * | `none`     | anything else: the same shape, a stricter class, an added | active           |
 * |            | required argument, a removed optional one, a body that    |                  |
 * |            | closed                                                    |                  |
 *
 * A widened operation is served as accepted (R6): under the accepted class,
 * which `effectiveClass` makes the stricter one, with only the accepted
 * parameters, and a body narrowed to the accepted properties (none, where no
 * body was accepted). So when both widened answers apply, either serves it
 * the same way, and the class is named. Body properties widen as parameters
 * do: a property a body gains (`role` on a user update, say) is as much a new
 * power as a new query parameter, and is held back the same way, and so is a
 * body itself, required or not, since no one reviewed what it may carry.
 */
export type Widening = "none" | "params" | "class" | "required" | "new";

export function widens(accepted: unknown, current: OperationFingerprint): Widening {
  const baseline = readFingerprint(accepted);
  if (!baseline) return "new";
  // The first index accepts an upload with the rest, and nothing about it
  // was ever served: whatever it turned into, nobody has looked at it.
  if (baseline.b === "upload" && current.b !== "upload") return "new";
  const required = new Set(current.req);
  if (baseline.req.some((name) => !required.has(name))) return "required";
  if (SEVERITY[current.cls] < SEVERITY[baseline.cls]) return "class";
  const added = (now: readonly string[], then: readonly string[], location: string) => {
    const before = new Set(then);
    return now.some((name) => !before.has(name) && !required.has(`${location}:${name}`));
  };
  if (
    added(current.q, baseline.q, "query") ||
    added(current.h, baseline.h, "header") ||
    added(current.body, baseline.body, "body") ||
    BODY_REACH[current.b] > BODY_REACH[baseline.b]
  ) {
    return "params";
  }
  return "none";
}

/** How far a body reaches. An upload is never served, so it reaches nothing. */
const BODY_REACH: Readonly<Record<BodyReach, number>> = {
  none: 0,
  closed: 1,
  open: 2,
  upload: 0,
};

/** Least to most severe. Denied is the strictest class of all. */
const SEVERITY: Readonly<Record<OperationClass, number>> = {
  read: 0,
  write: 1,
  destructive: 2,
  deny: 3,
};

/** A stored fingerprint, or null when it is not one this version can read. */
export function readFingerprint(value: unknown): OperationFingerprint | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (typeof record.cls !== "string" || !Object.hasOwn(SEVERITY, record.cls)) return null;
  const lists = [record.req, record.q, record.h, record.body];
  if (!lists.every((list) => Array.isArray(list) && list.every((x) => typeof x === "string"))) {
    return null;
  }
  if (typeof record.b !== "string" || !(BODY_REACHES as readonly string[]).includes(record.b)) {
    return null;
  }
  return {
    v: 1,
    cls: record.cls as OperationClass,
    req: canonical(record.req as string[]),
    q: canonical(record.q as string[]),
    h: canonical(record.h as string[]),
    body: canonical(record.body as string[]),
    b: record.b as BodyReach,
  };
}

function canonical(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}
