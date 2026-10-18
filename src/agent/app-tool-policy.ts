// Excerpt from a private codebase, shared for the Make Something Agents Want hackathon (README.md).
// Imports that point outside this folder are not included, so this does not build on its own.

import { z } from "@hono/zod-openapi";

import type { AutoConnectorEntry } from "../connectors/entry-schema";
import type { ConnectionDriver } from "../mcp/registry";

/**
 * What the console agent may call on an app's own MCP server without asking.
 *
 * Pilae no longer connects the apps it provisions to the agent, but legacy
 * connections still exist (staging's CMS carries twelve Directus tools), and
 * their calls are judged here. A connection is matched by `app_mcp.appId`,
 * which only provisioning ever wrote, from the recipe it ran, and which no
 * customer-facing route accepts. A connection added by hand has none, so it
 * gets no declaration and every call it makes is held to the defaults.
 *
 * These declarations used to live on the recipes. They moved here unchanged
 * when recipes stopped describing an MCP server: they are a statement about
 * the agent's approval policy, checked against the vendor's source for the
 * version the recipe pins (`src/recipes/<appId>.ts`), not about how an app is
 * installed.
 */

/**
 * A brick tool that reads or writes depending on one argument.
 *
 * Some apps put create, read, update and delete behind a single tool and an
 * `action` argument. Such a tool cannot honestly claim `readOnlyHint`, so every
 * call to it would raise a confirmation card, including the calls that only
 * list things. This is Pilae's own statement, checked against the vendor's
 * source for the version the recipe pins, that particular values of that
 * argument only read.
 *
 * It lives here, never on the connection, because nothing the app advertises
 * and nothing the model sends may widen what runs without asking. The app
 * decides only which tools exist. Whether a call is a read is decided here, in
 * code somebody reviewed.
 */
export const ReadActionSchema = z
  .object({
    /** The argument that selects the operation, e.g. `action`. */
    arg: z.string().min(1),
    /** The values of that argument that only read. Compared exactly. */
    values: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type ReadAction = z.infer<typeof ReadActionSchema>;

/**
 * A brick tool that deletes when one argument has one of a few values.
 *
 * The mirror of `ReadActionSchema`, and for the same kind of tool. Without it a
 * call that drops a table in a customer's app is an ordinary app write: it asks,
 * but the workspace's "no destructive actions" switch does not stop it and the
 * per-request limit on destructive proposals does not count it. A call that
 * matches gets that switch and that limit in the console agent, and the switch
 * and the `pilae:destructive` scope on the remote MCP endpoint (which has no
 * per-request limit to count against). It does not get the owner-only role
 * check a Pilae delete has at its route. A delete made through any other value
 * of the argument (a nested delete inside an update, say) is not matched and
 * keeps the app-write default.
 *
 * Not the app's `destructiveHint`. MCP defaults that hint to true, and an app
 * that puts create, update and delete behind one tool has to set it on the
 * whole tool, so honouring it would make every create "destructive" and teach
 * people to ignore the word. Same provenance as a read declaration: Pilae's own
 * statement, checked against the vendor's source for the pinned version, here
 * and never on the connection.
 */
export const DestructiveActionSchema = z
  .object({
    /** The argument that selects the operation, e.g. `action`. */
    arg: z.string().min(1),
    /** The values of that argument that delete. Compared exactly. */
    values: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type DestructiveAction = z.infer<typeof DestructiveActionSchema>;

export const AppToolPolicySchema = z
  .object({
    /**
     * Brick tools that only read when one argument has one of a few values,
     * keyed by the name the app ITSELF gives the tool (not the `brick_<slug>_`
     * name the model sees). A tool missing from here keeps the default: it runs
     * unasked only if the app marks it `readOnlyHint`, and asks otherwise.
     */
    readActions: z.record(z.string().min(1), ReadActionSchema).default({}),
    /**
     * Brick tools that delete when one argument has one of a few values, keyed
     * the same way as `readActions`. A tool missing from here, or a call whose
     * input does not match, keeps the default: it asks, as any app write does.
     */
    destructiveActions: z.record(z.string().min(1), DestructiveActionSchema).default({}),
    /**
     * Brick tools that only read, whatever they are called with, named exactly
     * as the app ITSELF names them.
     *
     * For the tool `readActions` cannot describe: one with no argument to key
     * a rule on, which the app still does not mark `readOnlyHint`. Every call
     * to it runs unasked, so the bar is higher than a read declaration's: the
     * vendor's source for the pinned version must show that no input changes
     * what it does, not merely that one value of one argument only reads.
     * Same provenance as the other two: Pilae's own statement, here and never
     * on the connection.
     */
    readTools: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((policy, ctx) => {
    // A tool that only ever reads can have no value that deletes, and needs no
    // per-value read rule. Either second claim means one of the two was
    // misread. The policy would settle a delete on the safe side (it is checked
    // first), but the reviewer should hear about both here.
    for (const tool of policy.readTools) {
      if (Object.hasOwn(policy.destructiveActions, tool)) {
        ctx.addIssue({
          code: "custom",
          message: `${tool} is declared both a read tool and destructive`,
        });
      }
      if (Object.hasOwn(policy.readActions, tool)) {
        ctx.addIssue({
          code: "custom",
          message: `${tool} is declared both a read tool and in readActions`,
        });
      }
    }
    const repeatedReadTools = policy.readTools.filter(
      (tool, index) => policy.readTools.indexOf(tool) !== index,
    );
    if (repeatedReadTools.length) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate readTools: ${repeatedReadTools.join(", ")}`,
      });
    }
    // One value cannot both only read and delete. The policy would settle it
    // on the safe side (a declared delete is checked first), but a policy that
    // says both has been misread, and the reviewer should hear about it here.
    for (const [tool, destructive] of Object.entries(policy.destructiveActions)) {
      const read = Object.hasOwn(policy.readActions, tool) ? policy.readActions[tool] : undefined;
      if (!read || read.arg !== destructive.arg) continue;
      const both = destructive.values.filter((value) => read.values.includes(value));
      if (both.length > 0) {
        ctx.addIssue({
          code: "custom",
          message: `${tool}: ${destructive.arg}=${both.join(", ")} is declared both read-only and destructive`,
        });
      }
    }
  });
export type AppToolPolicy = z.infer<typeof AppToolPolicySchema>;

/** Validate at module load, so a policy nobody could have meant fails at boot. */
export function defineAppToolPolicy(input: unknown): AppToolPolicy {
  const parsed = AppToolPolicySchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`invalid app tool policy: ${detail}`);
  }
  return parsed.data;
}

/**
 * Every declaration, by `app_mcp.appId`. A Map, so an appId such as
 * `constructor` finds nothing on `Object.prototype`.
 */
export const APP_TOOL_POLICIES: ReadonlyMap<string, AppToolPolicy> = new Map([
  [
    // The Directus recipe's MCP server (src/recipes/directus.ts pins the
    // version every statement below was checked against).
    "directus",
    defineAppToolPolicy({
      // Eight of Directus's twelve MCP tools put create, read, update and delete
      // (`files`: read, update, delete, import) behind one `action` argument, and
      // advertise only `destructiveHint`. So without this, listing flows raises the
      // same confirmation card as deleting one.
      //
      // Checked against the v12.4.0 source, the version the compose file pins,
      // under `api/src/ai/tools/<tool>/index.ts`:
      //
      //  - each of these declares `readOnly: (input) => input.action === 'read'`.
      //    That is Directus's own per-call classification, and the same predicate
      //    its own AI chat uses to skip approval. Its MCP server does not publish
      //    it (`tools/list` sends only the static annotations);
      //  - `action` is validated as `z.literal('read')` in a discriminated union
      //    before the handler runs, and it is not one of the fields Directus
      //    rewrites from JSON strings first (`data`, `keys`, `query`, `headers`);
      //  - the `read` branch calls only the service's read methods (`readByQuery`,
      //    `readMany`, `readOne`, `readAll`, `readSingleton`). The handler starts
      //    no flow and imports no file. (A `query.version` read previews a draft
      //    by applying it inside a transaction Directus always rolls back; only a
      //    Postgres sequence it touched stays advanced.)
      //
      // Read-only is not inert. A read still emits Directus's read events
      // (`items.query`, `items.read`, `<collection>.items.read`, and so on), as any
      // REST GET does, so a hook or flow the customer installs on read events can
      // act on it.
      //
      // Nor is every read harmless to show. `flows` and `operations` reads return
      // each operation's `options` in plaintext, request headers included (an
      // `Authorization` bearer, say), and a declared read puts that in front of
      // the model and into the transcript without a card. Before extending this
      // list, weigh what a tool's reads return, not only whether they write.
      //
      // Deliberately absent: `trigger-flow`, which RUNS a flow and has no read
      // form at all; `assets` and `schema`, which already say `readOnlyHint`; and
      // `system-prompt`, which has no `action` argument to key a rule on and is
      // declared whole in `readTools` below instead.
      //
      // The image pin guards NEW provisions only. This rule is keyed on the recipe,
      // not on the version running, so a Directus upgraded in place (its compose
      // file replaced) keeps it. Drift review will not notice either: the tool
      // fingerprint covers names, `readOnlyHint` and required arguments, not an
      // `action` enum or what a branch does. Re-read the source above before
      // bumping the pin. A value added to an enum upstream stays behind a card
      // until it is added here.
      readActions: {
        items: { arg: "action", values: ["read"] },
        files: { arg: "action", values: ["read"] },
        folders: { arg: "action", values: ["read"] },
        flows: { arg: "action", values: ["read"] },
        operations: { arg: "action", values: ["read"] },
        collections: { arg: "action", values: ["read"] },
        fields: { arg: "action", values: ["read"] },
        relations: { arg: "action", values: ["read"] },
      },

      // The same eight tools, for the calls that delete. Without this, dropping a
      // collection (a table, with every row in it) is an ordinary app write: it
      // asks, but a workspace with destructive actions switched off does not stop
      // it and the per-request limit does not count it. With it, the console
      // agent refuses these outright when the switch is off, and counts them
      // toward the limit when it is on. The remote MCP endpoint refuses them
      // when the switch is off too, and otherwise asks for `pilae:destructive`.
      //
      // Checked against the same v12.4.0 source, `api/src/ai/tools/<tool>/index.ts`:
      //
      //  - each tool's advertised `action` enum includes `delete` (`files`: read,
      //    update, delete, import; the rest: create, read, update, delete), and the
      //    discriminated union it is validated against has a `z.literal('delete')`
      //    branch;
      //  - that branch deletes: `deleteMany` for items, files, folders and
      //    collections, `deleteOne` for flows, operations and relations,
      //    `deleteField` for fields;
      //  - Directus's own gate keys on the same predicate. With `mcp_allow_deletes`
      //    off, `ToolRegistry` refuses a call whose parsed `action === 'delete'`
      //    (`api/src/ai/tools/registry.ts`). Pilae provisions with it off, so on a
      //    fresh instance these calls fail at the app anyway. This rule is what
      //    still holds when the customer switches it on in their own settings.
      //
      // What this does NOT cover: a delete expressed through any other action.
      // Those still ask on a card, like every app write, but the switch does not
      // refuse them and the limit does not count them. Known ways, in v12.4.0:
      //
      //  - a nested relational delete inside `items` `create` or `update`: `data`
      //    is an open record, and when a relation's `one_deselect_action` is
      //    `delete`, `PayloadService` deletes the related items named in the
      //    one-to-many field's `delete: [...]`, or left out of a replaced
      //    one-to-many array;
      //  - a flow that deletes: `operations` `create` with an `item-delete`
      //    operation, then `trigger-flow`, which can run anything a flow was built
      //    to do;
      //  - an `update` with a delete-like effect, such as archiving items or
      //    changing a field's `type`.
      //
      // Directus's own `mcp_allow_deletes` gate keys on `action === 'delete'` too,
      // so it misses the same calls. They are not declared here because matching
      // `delete` keys at any depth of `data` would be a guess about the payload
      // rather than a statement about the tool; `update` is the everyday write.
      //
      // The drift caveat above applies unchanged: re-read these branches before
      // bumping the pin.
      destructiveActions: {
        items: { arg: "action", values: ["delete"] },
        files: { arg: "action", values: ["delete"] },
        folders: { arg: "action", values: ["delete"] },
        flows: { arg: "action", values: ["delete"] },
        operations: { arg: "action", values: ["delete"] },
        collections: { arg: "action", values: ["delete"] },
        fields: { arg: "action", values: ["delete"] },
        relations: { arg: "action", values: ["delete"] },
      },

      // `system-prompt` returns the project's own guidance for AI clients, and the
      // agent reaches for it first when a conversation turns to a Directus app
      // (seen on staging). It has no `action` to key a read rule on and
      // advertises no `readOnlyHint`, so without this such a conversation opened
      // on a confirmation card for fetching some text.
      //
      // Checked against the v12.4.0 source, the version the compose file pins:
      //
      //  - `api/src/ai/tools/system/index.ts` declares `readOnly: true`, Directus's
      //    own classification and the flag its AI chat reads to skip approval
      //    (`#isReadOnly` in `api/src/ai/tools/registry.ts`). Its `annotations`
      //    hold a `title` only, and the legacy `tools/list` Pilae reads
      //    (`toMcpTool` in `api/src/ai/mcp/server.ts`) sends `annotations`
      //    unchanged, which is why no `readOnlyHint` reaches us;
      //  - no input reaches it. Its input schema is `z.object({})`, and
      //    `#parseInput` in `registry.ts` throws away whatever the call sends for
      //    this one tool, substituting `{ promptOverride: <the settings value> }`.
      //    That is what makes a whole-tool declaration sound here: there is no
      //    argument whose value could turn the call into something else;
      //  - the handler returns `{ type: 'text', data }`, where `data` is that
      //    override or the bundled `prompt.md` read with `readFileSync`
      //    (`api/src/utils/require-text.ts`). It calls no service, so it writes
      //    nothing and emits no event. The settings read that supplies the
      //    override happens in `api/src/controllers/mcp/index.ts` for every
      //    `/mcp` request, a tool list included, not because of this tool.
      //
      // What it returns is text whoever administers the instance wrote
      // (`mcp_system_prompt`), and it reaches the model as untrusted app output
      // like every brick result. A card never showed it either: a card shows the
      // call, and this call has nothing in it.
      //
      // Keyed by the exact name, so a renamed tool loses it. The drift caveat on
      // `readActions` applies, and harder: an argument added upstream that the
      // handler honours would run unasked, and drift review sees only required
      // arguments. Re-read the file above before bumping the pin.
      readTools: ["system-prompt"],
    }),
  ],
]);

/**
 * The read-by-argument rule declared for one of a connection's brick tools.
 *
 * `appId` must be the connection's `app_mcp.appId`, which only provisioning
 * ever wrote (from the recipe it ran, before it stopped connecting apps) and
 * which no customer-facing route accepts.
 * A connection added by hand has none, so it gets no rule. `upstreamName` is
 * the name the app gives the tool, matched exactly: a tool the app renames
 * loses the rule rather than carrying it to the new name.
 *
 * Own properties only. A tool the app calls `constructor` must not find
 * something on `Object.prototype` and treat it as a declaration.
 */
export function declaredReadAction(
  appId: string | null | undefined,
  upstreamName: string,
): ReadAction | null {
  return declared(appId, upstreamName, "readActions");
}

/**
 * The delete-by-argument rule declared for one of a connection's brick tools.
 *
 * Found exactly the way `declaredReadAction` finds a read, with the same
 * consequence for a connection added by hand: no policy, so no rule, so its
 * calls are held to the app-write default. That default still asks before
 * every call, so nothing on such a connection runs unasked. What it does not
 * get is the destructive switch and limit, because nothing Pilae reviewed says
 * which of its calls delete.
 */
export function declaredDestructiveAction(
  appId: string | null | undefined,
  upstreamName: string,
): DestructiveAction | null {
  return declared(appId, upstreamName, "destructiveActions");
}

/**
 * Is this brick tool declared read-only, whatever it is called with?
 *
 * Found through `appId` exactly as `declaredReadAction` finds a read, so a
 * connection added by hand, or one provisioned from another recipe that
 * happens to offer a tool of the same name, gets nothing. `upstreamName` is
 * matched exactly against the entries of the policy's own list: a renamed tool
 * loses the declaration, and a name like `constructor` or `length` matches no
 * entry, whatever arrays and objects carry on their prototypes.
 */
export function declaredReadTool(appId: string | null | undefined, upstreamName: string): boolean {
  return policyFor(appId)?.readTools.includes(upstreamName) === true;
}

/** Both declarations share one shape; they differ only in what a match means. */
function declared(
  appId: string | null | undefined,
  upstreamName: string,
  field: "readActions" | "destructiveActions",
): ReadAction | DestructiveAction | null {
  const rules = policyFor(appId)?.[field];
  if (!rules || !Object.hasOwn(rules, upstreamName)) return null;
  return rules[upstreamName] ?? null;
}

/**
 * The policy for the recipe a connection was provisioned from, which is the
 * only source of any declaration. None for a connection added by hand (no
 * `appId`), nor for a recipe that declares nothing.
 */
function policyFor(appId: string | null | undefined): AppToolPolicy | undefined {
  return appId ? APP_TOOL_POLICIES.get(appId) : undefined;
}

/**
 * What an app's connector entry adds to its MCP tools (`policy.mcp`), as the
 * entry format types it: tools to hide (`deny`), to card whatever the app
 * claims (`writes`), to hold to the destructive rules on every call
 * (`destructive`) or on the calls whose argument selects a delete
 * (`destructiveActions`). Entries only tighten, so it has no way to say a
 * tool reads (src/connectors/entry-schema.ts refuses those fields by name).
 */
export type EntryMcpPolicy = NonNullable<NonNullable<AutoConnectorEntry["policy"]>["mcp"]>;

/** Where an MCP tool's declarations may come from: its connection's own row. */
export interface McpPolicySource {
  /** An `api` row has no MCP tools, and is given no declaration. */
  driver: ConnectionDriver;
  /** `app_mcp.appId`, which keys `APP_TOOL_POLICIES`. */
  appId: string | null | undefined;
  /**
   * The `policy.mcp` of the entry matched for the connection's running
   * service, or null when no entry matched (or none says anything about MCP).
   */
  entryMcp?: EntryMcpPolicy | null;
}

/** Everything Pilae declares about one MCP tool, from whichever source applies. */
export interface McpToolDeclarations {
  /** Which source spoke: the reviewed policy, the entry, or neither. */
  source: "reviewed" | "entry" | null;
  /** Never offered to the agent: not built, so never searched or called. */
  hidden: boolean;
  /** Asks on every call, whatever the app's own `readOnlyHint` says. */
  writeTool: boolean;
  /** Reads, whatever it is sent (`readTools`). Only a reviewed policy says so. */
  readTool: boolean;
  /** Reads when one argument has a declared value. Only a reviewed policy says so. */
  readAction: ReadAction | null;
  /** Deletes when one argument has a declared value. */
  destructiveAction: DestructiveAction | null;
  /** Destructive on every call, whatever it is sent. */
  destructiveTool: boolean;
}

const NOTHING_DECLARED: McpToolDeclarations = Object.freeze({
  source: null,
  hidden: false,
  writeTool: false,
  readTool: false,
  readAction: null,
  destructiveAction: null,
  destructiveTool: false,
});

/**
 * Pilae's declarations for one MCP tool of a connection: `APP_TOOL_POLICIES`
 * for the connection's recipe when it has one, else its entry's `policy.mcp`,
 * else nothing (app-connectors PLAN §2, §5 R3).
 *
 * One source, never a blend. The reviewed policy wins whole: it was checked
 * against the vendor's source for the version the recipe pins, and the
 * catalogue refuses an entry that carries an MCP policy beside one
 * (`buildCatalogue`), so no entry in force has a list this would pass over.
 * An entry's policy only tightens: it can hide a tool, card one the app calls
 * read-only, or hold one to the destructive rules, and has no field that
 * would let a call run without a card.
 *
 * An `api` row gets nothing from here, whatever its `appId`: its tools are
 * operations of the app's OpenAPI document, which Pilae's operation policy
 * classes on its own (src/agent/operation-policy.ts), and a declaration keyed
 * by an MCP tool's name would be about some other tool that happens to share
 * a name with an operation.
 *
 * Names are matched exactly, against the entry's own lists and with
 * `Object.hasOwn` on its records, so a renamed tool loses its declaration and
 * a tool called `constructor` finds nothing on a prototype.
 */
export function mcpToolDeclarations(
  source: McpPolicySource,
  upstreamName: string,
): McpToolDeclarations {
  if (source.driver !== "mcp") return NOTHING_DECLARED;

  if (policyFor(source.appId)) {
    return {
      ...NOTHING_DECLARED,
      source: "reviewed",
      readTool: declaredReadTool(source.appId, upstreamName),
      readAction: declaredReadAction(source.appId, upstreamName),
      destructiveAction: declaredDestructiveAction(source.appId, upstreamName),
    };
  }

  const entry = source.entryMcp;
  if (!entry) return NOTHING_DECLARED;
  const rules = entry.destructiveActions;
  const rule = rules && Object.hasOwn(rules, upstreamName) ? rules[upstreamName] : undefined;
  return {
    ...NOTHING_DECLARED,
    source: "entry",
    hidden: entry.deny?.includes(upstreamName) === true,
    writeTool: entry.writes?.includes(upstreamName) === true,
    destructiveTool: entry.destructive?.includes(upstreamName) === true,
    destructiveAction: rule ? { arg: rule.arg, values: [...rule.values] } : null,
  };
}

/**
 * The app's own `readOnlyHint` for an MCP tool, as Pilae lets it stand: true
 * only when the app said so and Pilae declares the tool neither a writer
 * (`writeTool`) nor destructive on every call (`destructiveTool`).
 *
 * The approval policy would card a destructive tool whatever the hint says,
 * since it asks about `destructiveTool` first. But other readers have only the
 * hint: the Directus licence guard counts a call as a write on it
 * (`buildOne`), and the remote MCP endpoint annotates its tools from it (beside
 * `readTool` and `destructiveAction`, but not `destructiveTool`). A tool an
 * entry calls destructive must not reach either of them as a read.
 *
 * The connections page does not come through here: `toolsOf` and the verify
 * responses in `routes/agent-connections.ts` show the app's raw claim from the
 * tools cache. Once an entry's `policy.mcp` reaches an MCP row, a tool it lists
 * in `writes` or `destructive` still shows there as read-only until those
 * readers go through this function too.
 */
export function standingReadOnlyHint(
  appClaim: boolean | undefined,
  declared: Pick<McpToolDeclarations, "writeTool" | "destructiveTool">,
): boolean {
  return appClaim === true && !declared.writeTool && !declared.destructiveTool;
}
