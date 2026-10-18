// Excerpt from a private codebase, shared for the Make Something Agents Want hackathon (README.md).
// Imports that point outside this folder are not included, so this does not build on its own.

// The order an app's operations are offered in (PLAN §5 R2), which decides
// which of them a large app gets to offer at all: the agent's tool budget is
// filled per connection in rank order (R6), and remote `/mcp` lists tools the
// same way (R9).
//
// The order, each step breaking the previous one's ties:
//
//  1. the entry's `featured` operations, in the entry's order: a person chose
//     them, for this range of the app's versions, so they come first even
//     when the app has since marked one deprecated;
//  2. everything else not deprecated, before everything deprecated;
//  3. by role: lists, single reads, creates, updates, other reads, other
//     writes, destructive operations, and last the denied ones (stored for
//     the review screen, never served). Finding things is what most turns
//     start with, and an agent that can find and read a task can do most of
//     what is asked of it;
//  4. shallower paths first: `/tasks` before `/projects/{project}/tasks`;
//  5. the key, so the order is total and the same on every run.
//
// A role is read from the operation's shape and never from its class alone:
// in an RPC-style app every call is a POST (`/documents.list`,
// `/documents.info`), which the default policy treats as a write, and its
// lists still need to come first. So the verb an RPC path ends in counts as
// much as REST's method-and-path, and in a `resource.verb` path the method
// says nothing more (a POST to `/documents.archive` creates nothing). The
// class only separates what deletes (and what is denied) from the rest, and
// an operation whose verb says it removes something ranks with the
// destructive ones whatever its class. A rank changes no policy: the class an
// operation is called under is its class, and its card follows that.

import { operationMatches, parseOperationPattern } from "../operation-pattern";
import type { OperationClass } from "../store";
import type { Pagination } from "./operations";

export const RANK_ROLES = [
  "list",
  "get",
  "create",
  "update",
  "other_read",
  "other_write",
  "destructive",
  "denied",
] as const;
export type RankRole = (typeof RANK_ROLES)[number];

export interface RankableOperation {
  opKey: string;
  method: string;
  pathTemplate: string;
  policyClass: OperationClass;
  deprecated: boolean;
  itemsPath: string | null;
  pagination: Pagination | null;
}

// Verbs of an RPC-style path's last segment, as its first or last word:
// `documents.list`, `listDocuments`, `users-search`.
const LIST_VERBS = new Set(["list", "search", "query", "find", "all", "browse"]);
// Not `read`: a `PUT /tasks/{task}/read` marks something read.
const GET_VERBS = new Set(["info", "get", "show", "view", "fetch", "details", "retrieve"]);
const CREATE_VERBS = new Set(["create", "add", "new", "insert"]);
const UPDATE_VERBS = new Set(["update", "edit", "patch", "set", "rename", "modify"]);
const DELETE_VERBS = new Set(["delete", "remove", "destroy", "purge", "erase"]);

/** Where an operation sits in step 3 of the order. */
export function roleOf(op: RankableOperation): RankRole {
  if (op.policyClass === "deny") return "denied";
  if (op.policyClass === "destructive") return "destructive";
  const method = op.method.toUpperCase();
  const reading = method === "GET" || method === "HEAD";
  const { verbs, endsInParam, rpc } = shapeOf(op.pathTemplate);
  const says = (set: ReadonlySet<string>) => verbs.some((verb) => set.has(verb));

  // A list answers with several things: a bare array, a wrapper, or pages.
  const answersAList = op.itemsPath !== null || op.pagination !== null;
  if (reading) {
    // `/tasks/{task}` reads one thing, whatever arrays it holds.
    if (endsInParam) return "get";
    if (answersAList) return "list";
    return says(GET_VERBS) ? "get" : "other_read";
  }
  if (says(DELETE_VERBS)) return "destructive";
  // RPC reads are POSTs; a PUT or a PATCH named `…/show` still changes
  // something, and ranks as the change it is.
  if (method === "POST") {
    if (answersAList && says(LIST_VERBS)) return "list";
    if (says(GET_VERBS)) return "get";
  }
  if (says(CREATE_VERBS)) return "create";
  if (says(UPDATE_VERBS)) return "update";
  // REST's shape, which an RPC path (`/documents.archive`) does not have: a
  // POST to a collection creates, and a PUT of an item updates. A PATCH
  // changes part of whatever it names (RFC 5789), an item or a part of one
  // (`/users/{id}/status`), so it updates wherever it points; a PUT to
  // anything else is usually an action (`/tasks/{id}/read`, `/tasks/bulk`).
  if (!rpc) {
    if (method === "POST" && !endsInParam) return "create";
    if (method === "PATCH" || (method === "PUT" && endsInParam)) return "update";
  }
  return op.policyClass === "read" ? "other_read" : "other_write";
}

/**
 * Sort operations into rank order and number them from 0, the `rank` column.
 * `featured` holds the entry's keys (`api:METHOD /path`, a `{name}` segment
 * matching any parameter, as the entry format reads them); keys of another
 * driver, or that match nothing, are ignored.
 */
export function rankOperations<T extends RankableOperation>(
  operations: readonly T[],
  featured: readonly string[] = [],
): (T & { rank: number })[] {
  const patterns = featured.flatMap((key) => {
    if (!key.startsWith("api:")) return [];
    const pattern = parseOperationPattern(key.slice(4), { wildcards: false });
    return pattern ? [pattern] : [];
  });

  const keyed = operations.map((op) => {
    const featuredAt = patterns.findIndex((pattern) =>
      operationMatches(pattern, op.method, op.pathTemplate),
    );
    return {
      op,
      featuredAt: featuredAt === -1 ? patterns.length : featuredAt,
      deprecated: featuredAt === -1 && op.deprecated ? 1 : 0,
      role: RANK_ROLES.indexOf(roleOf(op)),
      depth: op.pathTemplate.split("/").filter((segment) => segment !== "").length,
    };
  });
  keyed.sort(
    (a, b) =>
      a.featuredAt - b.featuredAt ||
      a.deprecated - b.deprecated ||
      a.role - b.role ||
      a.depth - b.depth ||
      (a.op.opKey < b.op.opKey ? -1 : a.op.opKey > b.op.opKey ? 1 : 0),
  );
  return keyed.map(({ op }, rank) => ({ ...op, rank }));
}

/**
 * The words that can name a verb (the first and last of the last static
 * segment, split as tool names split paths: on punctuation and camelCase),
 * whether the path ends in a parameter, and whether it ends the RPC way, in a
 * `resource.verb` segment.
 */
function shapeOf(pathTemplate: string): { verbs: string[]; endsInParam: boolean; rpc: boolean } {
  const segments = pathTemplate.split("/").filter((segment) => segment !== "");
  const last = segments[segments.length - 1];
  const isParam = (segment: string) => /^\{[^{}]*\}$/.test(segment);
  const endsInParam = last !== undefined && isParam(last);
  const rpc = last !== undefined && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/.test(last);
  const lastStatic = [...segments].reverse().find((segment) => !isParam(segment));
  if (lastStatic === undefined) return { verbs: [], endsInParam, rpc };
  const words = lastStatic
    .replace(/\{[^{}]*\}/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
  const first = words[0];
  const final = words[words.length - 1];
  return {
    verbs: first === undefined ? [] : first === final ? [first] : [first, final!],
    endsInParam,
    rpc,
  };
}
