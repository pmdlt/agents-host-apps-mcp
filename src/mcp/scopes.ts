// Excerpt from a private codebase, shared for the Make Something Agents Want hackathon (README.md).
// Imports that point outside this folder are not included, so this does not build on its own.

import type { ToolMeta } from "../agent/tools/generated";
import { roleAtLeast } from "../middleware/require-role";

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
 * An owner who authorized Claude Code for everything, and is a member today,
 * has a token that still says `pilae:destructive`. It buys them what a member
 * may do with it — cancel a stuck run, withdraw their own request — and nothing
 * an owner may.
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
 * Which scopes each role may hold at all, whatever a token claims.
 *
 * NOT the role matrix. The matrix is each route's own `x-min-role`, carried on
 * every tool as `minRole` and checked per call (`decideScope`). This is only
 * the ceiling a token is narrowed to before that check, and it is wide on
 * purpose: every role has writes and recoveries of its own — a member asks for
 * a deploy, installs an app where the workspace allows it, cancels a stuck run
 * — and a ceiling that kept members to `pilae:read` made the remote surface
 * read-only for them while the API and the console let them do all of that.
 *
 * "Destructive means owner" used to live here as well. It disagreed with the
 * routes in both directions — an admin may stop a service or remove a domain,
 * and only an owner may create a backup config, which is a write — so admins
 * were refused what the API lets them do and shown what it would refuse. A
 * second matrix drifts from the first; this one had.
 *
 * `pilae:apps` is the one real ceiling, and it stays with admin and above:
 * reaching inside a customer's own application can write to it, no route's
 * role stands behind that call to borrow, and the connection's own
 * `readOnlyHint` is the app's claim about itself, not a permission Pilae
 * granted.
 */
export const ROLE_SCOPES: Record<OrgRole, ReadonlySet<Scope>> = {
  member: new Set<Scope>([
    "openid",
    "offline_access",
    "pilae:read",
    "pilae:write",
    "pilae:destructive",
  ]),
  admin: new Set<Scope>([
    "openid",
    "offline_access",
    "pilae:read",
    "pilae:write",
    "pilae:destructive",
    "pilae:apps",
  ]),
  owner: new Set<Scope>([
    "openid",
    "offline_access",
    "pilae:read",
    "pilae:write",
    "pilae:destructive",
    "pilae:apps",
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
 * What this caller's token can still do: what it was granted, narrowed to what
 * the role may hold.
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

/**
 * What one call needs: a scope on the token, and a role in the workspace.
 *
 * Both, always. The scope is what the customer let the APPLICATION do; the
 * role is what the PERSON may do, and for a route tool it is that route's own
 * `x-min-role`, which the catalogue carries as `minRole`
 * (`test/mcp/remote-server.test.ts` holds the tool list to the API document's
 * roles). The route checks the role again when the call re-enters it, so this
 * is never the only gate: it is what keeps the tool list honest and a refusal
 * legible.
 */
export interface ToolRequirement {
  scope: Scope;
  minRole: OrgRole;
}

/** A Pilae tool's requirement, from its catalogue entry or a hand-written one's. */
export function requirementForTool(
  meta: Pick<ToolMeta, "destructive" | "mutation" | "minRole">,
): ToolRequirement {
  return { scope: scopeForTool(meta), minRole: meta.minRole };
}

/** Every brick tool needs this, whatever the app says about itself. */
export const BRICK_SCOPE: Scope = "pilae:apps";

/**
 * Calling a tool in a customer's own application.
 *
 * `member` because the ceiling already says the rest: no member may hold
 * `pilae:apps` (`ROLE_SCOPES`), and stating "admin" here as well would only
 * be a second place to forget when that decision changes.
 */
export const BRICK_REQUIREMENT: ToolRequirement = { scope: BRICK_SCOPE, minRole: "member" };

/**
 * A brick call that matches the delete its app's recipe declares
 * (`isDeclaredDestructive`), on top of `BRICK_REQUIREMENT`.
 *
 * The scope a Pilae delete needs, because a dropped collection is as final as
 * a deleted service, and with it the workspace's destructive switch. No route
 * stands behind the call whose role could be borrowed, so the role is
 * whatever lets a person reach into the app at all.
 */
export const DECLARED_DELETE_REQUIREMENT: ToolRequirement = {
  scope: "pilae:destructive",
  minRole: "member",
};

/** What `decideScope` reads off the caller. `McpPrincipal` is one. */
export interface CallerAuthority {
  orgRole: OrgRole;
  /** Token scopes already narrowed by the role (`effectiveScopes`). */
  scopes: ReadonlySet<Scope>;
  /** `org_agent_settings.allowDestructive`, read live with the membership. */
  allowDestructive: boolean;
}

export type ScopeDecision =
  | { ok: true }
  | { ok: false; kind: "insufficient_scope"; required: Scope }
  | { ok: false; kind: "insufficient_role"; required: Scope; role: OrgRole | null }
  | { ok: false; kind: "destructive_disabled"; required: Scope };

export type ScopeRefusal = Exclude<ScopeDecision, { ok: true }>;

const ROLES_LEAST_FIRST: readonly OrgRole[] = ["member", "admin", "owner"];

/**
 * The least role that could make this call, or null if none could: "that needs
 * an admin" is something a person can act on, where "not permitted" is not.
 */
export function leastRoleFor(requirement: ToolRequirement): OrgRole | null {
  return (
    ROLES_LEAST_FIRST.find(
      (role) => roleAtLeast(role, requirement.minRole) && ROLE_SCOPES[role].has(requirement.scope),
    ) ?? null
  );
}

/**
 * May this call proceed?
 *
 * Three refusals, deliberately distinct because a client can act on one and
 * not the other two, and checked in this order so the fixable one is offered
 * only when fixing it would actually let the call through:
 *
 *  1. **The role**: below the tool's `minRole`, or one that may not hold the
 *     scope at all. No amount of re-authorizing makes a member an owner, so
 *     telling a client to step up would send it round a loop that cannot
 *     terminate.
 *  2. **The workspace**: `allowDestructive` off refuses every destructive call,
 *     whoever makes it, as the console's policy does. Staff own that switch;
 *     the client cannot change it either.
 *  3. **The scope**: fixable. The application asks for it and the customer
 *     approves, so it earns a 403 with an `insufficient_scope` challenge
 *     naming what to request.
 */
export function decideScope(requirement: ToolRequirement, caller: CallerAuthority): ScopeDecision {
  const { scope, minRole } = requirement;
  if (!roleAtLeast(caller.orgRole, minRole) || !ROLE_SCOPES[caller.orgRole].has(scope)) {
    return {
      ok: false,
      kind: "insufficient_role",
      required: scope,
      role: leastRoleFor(requirement),
    };
  }
  if (scope === "pilae:destructive" && !caller.allowDestructive) {
    return { ok: false, kind: "destructive_disabled", required: scope };
  }
  if (!caller.scopes.has(scope)) {
    return { ok: false, kind: "insufficient_scope", required: scope };
  }
  return { ok: true };
}

/**
 * The workspace's refusal, starting "Not run:" as the console's do
 * (`DENIAL_FOR_MODEL` in src/agent/approval.ts) and as the server's
 * instructions explain: the mark of a rule, not of a person saying no.
 */
export const DESTRUCTIVE_DISABLED_SENTENCE =
  "Not run: destructive actions are switched off for this workspace.";

/**
 * What a refused call is told, in words a client may repeat to the customer.
 * Vendor-neutral for that reason.
 */
export function refusalSentence(decision: ScopeRefusal): string {
  switch (decision.kind) {
    case "destructive_disabled":
      return DESTRUCTIVE_DISABLED_SENTENCE;
    case "insufficient_role":
      return decision.role
        ? `Your role in this workspace does not permit that action. It needs the ${decision.role} role.`
        : "Your role in this workspace does not permit that action.";
    case "insufficient_scope":
      return `This application needs the ${decision.required} permission.`;
  }
}
