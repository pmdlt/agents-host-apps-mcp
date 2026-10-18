// Excerpt from a private codebase, shared for the Make Something Agents Want hackathon (README.md).
// Imports that point outside this folder are not included, so this does not build on its own.

import type { ToolMeta } from "../agent/tools/generated";

/**
 * What a token may ask for, and what a role may actually do.
 *
 * These are two different things and conflating them is the mistake this file
 * exists to prevent. A scope is what an APPLICATION requested and a customer
 * approved; a role is what the PERSON is allowed to do in that workspace. The
 * permission granted is the intersection, re-computed on every call — never the
 * scope alone, because the scope was frozen into a token days ago and the role
 * is a live fact.
 *
 * A member who was an owner when they authorized Claude Code, and is a member
 * today, has a token that still says `pilae:destructive`. It buys them nothing.
 */

export const SCOPES = [
  "openid",
  "offline_access",
  "pilae:read",
  "pilae:write",
  "pilae:destructive",
  "pilae:apps",
] as const;

export type Scope = (typeof SCOPES)[number];

export type OrgRole = "member" | "admin" | "owner";

/**
 * The ceiling each role imposes, whatever a token claims.
 *
 * Mirrors the published role matrix exactly — member reads, admin operates,
 * owner destroys — because a second, subtly different matrix for the remote
 * surface is how one of them drifts and nobody notices which.
 *
 * `pilae:apps` sits with admin rather than member: reaching inside a customer's
 * own application can write to it, and the connection's own `readOnlyHint` is
 * the app's claim about itself, not a permission Pilae granted.
 */
export const ROLE_SCOPES: Record<OrgRole, ReadonlySet<Scope>> = {
  member: new Set<Scope>(["openid", "offline_access", "pilae:read"]),
  admin: new Set<Scope>(["openid", "offline_access", "pilae:read", "pilae:write", "pilae:apps"]),
  owner: new Set<Scope>([
    "openid",
    "offline_access",
    "pilae:read",
    "pilae:write",
    "pilae:apps",
    "pilae:destructive",
  ]),
};

/** Parse the `scope` claim, which is a space-delimited string by the spec. */
export function parseScopeClaim(claim: unknown): Set<string> {
  if (Array.isArray(claim)) {
    return new Set(claim.filter((entry): entry is string => typeof entry === "string"));
  }
  if (typeof claim !== "string") return new Set();
  return new Set(claim.split(/\s+/).filter(Boolean));
}

/**
 * What this caller can actually do: what the token was granted, narrowed to what
 * the role still allows.
 *
 * Intersection, never union — and computed rather than stored, so a role change
 * takes effect on the next call rather than on the next token.
 */
export function effectiveScopes(tokenScopes: Set<string>, role: OrgRole): Set<Scope> {
  const allowed = ROLE_SCOPES[role];
  const out = new Set<Scope>();
  for (const scope of allowed) {
    if (tokenScopes.has(scope)) out.add(scope);
  }
  return out;
}

/**
 * The scope one Pilae tool needs.
 *
 * Read from the catalogue's own classification rather than restated here: the
 * console and the remote endpoint must agree about which tools are destructive,
 * and two lists would eventually disagree.
 */
export function scopeForTool(meta: Pick<ToolMeta, "destructive" | "mutation">): Scope {
  if (meta.destructive) return "pilae:destructive";
  if (meta.mutation) return "pilae:write";
  return "pilae:read";
}

/** Every brick tool needs this, whatever the app says about itself. */
export const BRICK_SCOPE: Scope = "pilae:apps";

export type ScopeDecision =
  | { ok: true }
  | { ok: false; kind: "insufficient_scope"; required: Scope }
  | { ok: false; kind: "insufficient_role"; required: Scope };

/**
 * May this call proceed?
 *
 * The two refusals are deliberately different, because the client can act on one
 * and not the other. A missing SCOPE is fixable: the application asks for it and
 * the customer approves, so it earns a 403 with an `insufficient_scope`
 * challenge naming what to request. A missing ROLE is not: no amount of
 * re-authorizing makes a member an owner, so telling a client to step up would
 * send it round a loop that cannot terminate.
 */
export function decideScope(
  required: Scope,
  granted: ReadonlySet<Scope>,
  role: OrgRole,
): ScopeDecision {
  if (granted.has(required)) return { ok: true };
  if (!ROLE_SCOPES[role].has(required)) {
    return { ok: false, kind: "insufficient_role", required };
  }
  return { ok: false, kind: "insufficient_scope", required };
}
