// Excerpt from a private codebase, shared for the Make Something Agents Want hackathon (README.md).
// Imports that point outside this folder are not included, so this does not build on its own.

import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import type { ToolSet } from "ai";

import { isDeclaredDestructive } from "../agent/approval";
import { buildWorkflowsGuideTool } from "../agent/knowledge/workflows";
import { type BrickToolMeta, type BrickToolSet, buildBrickTools } from "../agent/mcp-tools";
import { type createSelfFetchContext, selfFetch } from "../agent/self-fetch";
import type { ToolExecution } from "../agent/tools/build";
import { TOOL_META, type ToolMeta } from "../agent/tools/generated";
import { buildHandwrittenTools } from "../agent/tools/handwritten";
import { HANDWRITTEN_TOOL_META, type HandwrittenToolMeta } from "../agent/tools/handwritten-meta";
import { createDb } from "../db/client";
import type { Analytics } from "../lib/posthog";
import { API_VERSION_PREFIX } from "../lib/version";
import { INSTALL_STARTING_ROUTES } from "../middleware/provisioning-gate";
import { CallOutcomes, instrumentMcpServer } from "./analytics";
import { MCP_INSTRUCTIONS } from "./instructions";
import type { McpPrincipal } from "./principal";
import {
  BRICK_REQUIREMENT,
  DECLARED_DELETE_REQUIREMENT,
  decideScope,
  refusalSentence,
  requirementForTool,
  type ScopeRefusal,
  type ToolRequirement,
} from "./scopes";

/**
 * Pilae as an MCP server.
 *
 * The same capabilities the console's agent has, offered to a customer's own
 * client — Claude Code, Cursor, claude.ai. The tools are the same tools: both
 * surfaces execute by re-entering a real route through `selfFetch`, so there is
 * one implementation of every action and one place its role check lives.
 *
 * What differs is the gate in front. The console has a conversation and a human
 * watching it, so a confirmation card can ask before something destructive. A
 * remote client has neither, so the control is the token's scope, the
 * caller's live role against each tool's own minimum, and the workspace's
 * destructive switch — decided before the tool is ever invoked.
 *
 * The console's other destructive control, at most two destructive actions put
 * to the customer per message they send, is deliberately not ported. It
 * counts against the customer's message, and a remote client has no message
 * Pilae can see: every call is its own request, so there is no boundary to
 * count to. A count kept per token or per hour instead would cut a legitimate
 * clean-up off halfway, and still let through the one call that matters.
 */

/** No tool list is worth an unbounded registration loop. */
const MAX_BRICK_TOOLS = 60;

export interface McpServerOptions {
  env: Env;
  principal: McpPrincipal;
  ctx: ReturnType<typeof createSelfFetchContext>;
  /** The request's product analytics: PostHog's MCP events (`./analytics`). */
  analytics?: Analytics;
  /**
   * The workspace's app tools, when the request gate already built them to
   * judge an app call (`handleMcpRequest`), so the server does not read the
   * same connections a second time. Built here otherwise.
   */
  bricks?: BrickToolSet;
}

/** The workspace's app tools, as both the request gate and the server build them. */
export function loadBrickTools(env: Env, principal: McpPrincipal): Promise<BrickToolSet> {
  return buildBrickTools({ db: createDb(env.DB), organizationId: principal.organizationId });
}

/**
 * What an app call needs beyond `BRICK_REQUIREMENT`, decided on its own
 * arguments: `DECLARED_DELETE_REQUIREMENT` when it matches the delete its
 * app's recipe declares (`isDeclaredDestructive`), and null otherwise.
 *
 * One function for the request gate and the tool's own re-check, so the two
 * cannot disagree about which call deletes. The gate is the one that matters
 * to a client: it answers a missing `pilae:destructive` with the step-up
 * challenge, where the re-check can only return a tool error.
 */
export function brickCallRequirement(
  meta: Pick<BrickToolMeta, "destructiveAction"> | undefined,
  args: unknown,
): ToolRequirement | null {
  return meta && isDeclaredDestructive(meta.destructiveAction, args)
    ? DECLARED_DELETE_REQUIREMENT
    : null;
}

/**
 * Which Pilae tools this caller may see.
 *
 * Hidden BEFORE registration rather than refused on call, because a tool list is
 * a promise: an MCP client shows `pilae_services_delete` to its user, who asks
 * for it, and only then learns it was never possible. Advertising only what can
 * actually be called is the honest version: a member's client shows the
 * member's own writes and recoveries and no owner's delete, and a workspace
 * with destructive actions switched off shows no destructive tool at all.
 *
 * Nor are the tools that start an install offered to a workspace the
 * provisioning gate refuses — one with neither App installs nor the console
 * agent (`McpPrincipal.provisioningAdmitted`). Their routes answer it 404,
 * whoever asks; `pilae_provisioning_capabilities`, which is not gated, stays
 * to say why.
 */
export function visibleTools(principal: McpPrincipal): ToolMeta[] {
  return TOOL_META.filter((meta) => {
    if (meta.hidden) return false;
    if (!principal.provisioningAdmitted && startsAnInstall(meta)) return false;
    return decideScope(requirementForTool(meta), principal).ok;
  });
}

/** Whether a route tool calls one of the routes behind the provisioning gate. */
export function startsAnInstall(meta: Pick<ToolMeta, "method" | "path">): boolean {
  return INSTALL_STARTING_ROUTES.has(`${meta.method} ${meta.path}`);
}

/**
 * The hand-written tools a remote client is offered as well.
 *
 * Each wraps a route that is hidden on both surfaces for the same reason on
 * both, and is the only way either reaches it:
 *
 *  - The workflow guide and run readers. The workflow tools' descriptions,
 *    which both surfaces share, send the model to the guide and to these two;
 *    without them a client could start a test run and never see what it
 *    printed or returned. Program output reaches a model only redacted and
 *    marked untrusted.
 *  - A service's logs (`pilae_read_logs`), redacted and marked untrusted for
 *    the same reason, and the two keys-only reads: environment variable NAMES
 *    (`pilae_env_keys`) and a compose stack's services and images
 *    (`pilae_compose_services`). The raw routes return values and the whole
 *    secret-bearing file; these never do. Without them a remote client could
 *    deploy a service and not see why it fails, or edit an environment
 *    without knowing which variables it holds.
 *  - A deployment's build log (`pilae_read_deploy_log`), redacted and marked
 *    untrusted like the service's logs. `pilae_services_deployments`, whose
 *    description both surfaces share, sends the model to it to see why a
 *    deploy failed.
 *
 * Gated like every route tool: the scope from its classification and its own
 * `minRole`, which for the two keys-only reads is the admin role their routes
 * require. The rest — documentation and web search, the playbook, tool
 * search — stay console-only: they serve the console's own model, and a
 * remote client brings its own.
 */
export const REMOTE_HANDWRITTEN_META: ReadonlyMap<string, HandwrittenToolMeta> = new Map(
  [
    "pilae_read_logs",
    "pilae_env_keys",
    "pilae_compose_services",
    "pilae_read_deploy_log",
    "pilae_workflows_guide",
    "pilae_workflows_run_logs",
    "pilae_workflows_run_result",
  ].flatMap((name) => {
    const meta = HANDWRITTEN_TOOL_META.get(name);
    return meta ? [[name, meta] as const] : [];
  }),
);

/** Which of those this caller may see, by the same rule as `visibleTools`. */
export function visibleHandwrittenTools(principal: McpPrincipal): HandwrittenToolMeta[] {
  return [...REMOTE_HANDWRITTEN_META.values()].filter(
    (meta) => decideScope(requirementForTool(meta), principal).ok,
  );
}

/** Substitute `{name}` placeholders and strip the version prefix. */
function renderPath(meta: ToolMeta, args: Record<string, unknown>): string {
  let path = meta.path;
  for (const name of meta.pathParams) {
    const value = args[name];
    if (value === undefined || value === null) {
      throw new Error(`missing required path parameter: ${name}`);
    }
    path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
  }
  return path.startsWith(API_VERSION_PREFIX) ? path.slice(API_VERSION_PREFIX.length) : path;
}

function renderQuery(meta: ToolMeta, args: Record<string, unknown>) {
  const query: Record<string, string | number | boolean | undefined> = {};
  for (const name of meta.queryParams) {
    const value = args[name];
    if (value === undefined || value === null) continue;
    query[name] = value as string | number | boolean;
  }
  return query;
}

/** MCP's result shape. Text, because that is what every client can render. */
function asResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

type McpResult = ReturnType<typeof asResult>;

/**
 * What a handler answers: the client's result and, for analytics alone, how
 * the call ended — never the error's sentence, the call's arguments or its
 * result. The console's tool spans report the same two things under PostHog's
 * own names (`$ai_error`, `$ai_http_status` in src/agent/posthog-telemetry.ts),
 * read by the same rules.
 */
interface Answer {
  result: McpResult;
  /** The code a failed call handed the client, when Pilae gave it one. */
  code?: unknown;
  /** The HTTP status of the route of Pilae's the call reached, however it answered. */
  status?: number;
}

/**
 * A tool's own output as a result, marked an error whenever the tool failed.
 *
 * Failure is read the way the console's accounting reads it: Pilae's
 * `ok: false` — a refusal, a connection that has gone, an app at its licence
 * cap, an app that could not be reached — or the app's own `isError`, bare or
 * under `app` when Pilae put a notice beside it. Without the flag a client
 * takes the refusal for a success and carries on as though the write landed.
 */
function asToolResult(output: unknown, status?: number): Answer {
  const { ok, code, isError, app } = (output && typeof output === "object" ? output : {}) as {
    ok?: unknown;
    code?: unknown;
    isError?: unknown;
    app?: { isError?: unknown };
  };
  const failed = ok === false || isError === true || app?.isError === true;
  return {
    result: asResult(output, failed),
    // `ok: false` is Pilae's own envelope, whoever's tool it is (an app's
    // answer is wrapped as `content`, never spread beside it), so its code is
    // Pilae's to report. An app's own error says nothing more than the flag.
    ...(ok === false ? { code } : {}),
    ...(status === undefined ? {} : { status }),
  };
}

/**
 * A call the re-check refused, as a tool error: the same sentence the request
 * gate would have answered with, and the refusal's kind as its code.
 */
function refusedResult(decision: ScopeRefusal): Answer {
  return {
    result: asResult({ ok: false, error: refusalSentence(decision), code: decision.kind }, true),
    code: decision.kind,
  };
}

/**
 * What a handler knew of its call before it could answer, for a call that
 * throws instead: the status of a route of Pilae's it had already read.
 */
interface Seen {
  status?: number;
}

/**
 * A tool handler that records how its call ended (`CallOutcomes`,
 * src/mcp/analytics.ts), for that call's `$mcp_tool_call`: the HTTP status of
 * the route of Pilae's the call reached, however it answered, and for a
 * failure the code the client was handed (`NOT_FOUND`, `insufficient_role`),
 * which is what a failed call is diagnosed by. Never its arguments, its result
 * or an error's text: those are the customer's data.
 */
function recorded<A>(
  outcomes: CallOutcomes | undefined,
  toolName: string,
  handler: (args: A, seen: Seen) => Promise<Answer>,
): (args: A) => Promise<McpResult> {
  return async (args) => {
    const seen: Seen = {};
    try {
      const { result, code, status } = await handler(args, seen);
      outcomes?.record(toolName, {
        ...(result.isError === true && code !== undefined ? { code } : {}),
        ...(status === undefined ? {} : { status }),
      });
      return result;
    } catch (err) {
      // A throw hands the client no code of Pilae's; it is reported the way
      // the catalogue's own adapter reports one (`TOOL_ERROR`), with the
      // status of a route the call had read before it threw, as the
      // console's span reports it.
      outcomes?.record(toolName, {
        code: "TOOL_ERROR",
        ...(seen.status === undefined ? {} : { status: seen.status }),
      });
      throw err;
    }
  };
}

/**
 * Build the server for one request.
 *
 * Per request, not per process: the tool list depends on who is asking and what
 * their role is right now, and a server built once and reused would keep
 * offering an owner's tools to whoever connected next.
 *
 * `outcomes`, when given, is where each tool's handler records how its call
 * ended, for the request's analytics (`mcpHandlerFor`).
 */
export async function buildMcpServer(
  options: McpServerOptions,
  outcomes?: CallOutcomes,
): Promise<McpServer> {
  const { env, principal, ctx } = options;
  // The instructions are the same for everyone (src/mcp/instructions.ts says
  // why); only the tools below depend on who is asking.
  const server = new McpServer(
    { name: "pilae", version: "1.0.0" },
    { instructions: MCP_INSTRUCTIONS },
  );

  for (const meta of visibleTools(principal)) {
    server.registerTool(
      meta.name,
      {
        description: meta.description,
        // `fromJsonSchema` turns the catalogue's plain JSON Schema into what
        // `registerTool` wants; no hand-written adapter is needed.
        inputSchema: fromJsonSchema(meta.inputSchema as never),
        annotations: {
          readOnlyHint: !meta.mutation,
          destructiveHint: meta.destructive,
          idempotentHint: meta.method === "PUT" || meta.method === "DELETE",
        },
      },
      recorded(outcomes, meta.name, async (rawArgs: unknown) => {
        const args = (rawArgs ?? {}) as Record<string, unknown>;
        // Re-checked at call time as well as at registration. Registration
        // decided what to ADVERTISE; this decides what may RUN, and the two
        // must not be able to disagree — a client can call a name it was never
        // offered.
        const decision = decideScope(requirementForTool(meta), principal);
        if (!decision.ok) return refusedResult(decision);

        const result = await selfFetch(
          env,
          ctx,
          {
            userId: principal.userId,
            organizationId: principal.organizationId,
            surface: "mcp",
            context: principal.clientId ?? "mcp",
            tool: meta.name,
          },
          {
            method: meta.method,
            path: renderPath(meta, args),
            query: renderQuery(meta, args),
            body: meta.method === "GET" ? undefined : (args.body ?? {}),
          },
        );

        return result.ok
          ? { result: asResult(result.data), status: result.status }
          : {
              result: asResult({ ok: false, error: result.error, code: result.code }, true),
              code: result.code,
              status: result.status,
            };
      }),
    );
  }

  // The hand-written tools this surface offers (`REMOTE_HANDWRITTEN_META`).
  // Built with the console's own constructors, so both surfaces run the same
  // code; their self-calls carry this caller, exactly like the routes above.
  // Each reports how its call ended, as it does to the console, and that
  // record is the only place the status of the route it read is known: it
  // stays inside the tool's answer. Kept by the call's own id, for as long
  // as the call runs.
  const executed = new Map<string, ToolExecution>();
  const handwritten: ToolSet = {
    ...buildHandwrittenTools({
      env,
      ctx,
      principal: {
        userId: principal.userId,
        organizationId: principal.organizationId,
        surface: "mcp",
        context: principal.clientId ?? "mcp",
      },
      onExecuted: (record) => executed.set(record.toolCallId, record),
    }),
    ...buildWorkflowsGuideTool(),
  };
  for (const meta of visibleHandwrittenTools(principal)) {
    const tool = handwritten[meta.name];
    const execute = tool?.execute;
    if (!tool || !execute) continue;
    server.registerTool(
      meta.name,
      {
        description: String(tool.description ?? ""),
        inputSchema: fromJsonSchema(
          ((tool.inputSchema as { jsonSchema?: unknown })?.jsonSchema ?? {
            type: "object",
            properties: {},
          }) as never,
        ),
        annotations: { readOnlyHint: !meta.mutation, destructiveHint: meta.destructive },
      },
      recorded(outcomes, meta.name, async (rawArgs: unknown, seen) => {
        // Re-checked at call time, as for the routes above.
        const decision = decideScope(requirementForTool(meta), principal);
        if (!decision.ok) return refusedResult(decision);
        // An id of the call's own, so two calls of one tool in a request
        // cannot read each other's record.
        const toolCallId = crypto.randomUUID();
        try {
          const output = await execute(
            (rawArgs ?? {}) as never,
            {
              toolCallId,
              messages: [],
            } as never,
          );
          return asToolResult(output, executed.get(toolCallId)?.status);
        } catch (err) {
          // A tool that threw after its route answered still reports that
          // route's status, which its record holds: its console span does.
          seen.status = executed.get(toolCallId)?.status;
          throw err;
        } finally {
          executed.delete(toolCallId);
        }
      }),
    );
  }

  // The customer's own applications, if the token was granted that scope.
  if (decideScope(BRICK_REQUIREMENT, principal).ok) {
    const bricks = options.bricks ?? (await loadBrickTools(env, principal));

    let registered = 0;
    for (const [toolName, meta] of bricks.meta) {
      if (registered >= MAX_BRICK_TOOLS) break;
      const tool = bricks.tools[toolName];
      if (!tool) continue;

      // Pilae's own declarations outrank the app's claims, as in the console's
      // policy: a tool whose recipe declares a delete is never advertised as a
      // read, whatever the app says, and is the only kind advertised as
      // destructive. Every other tool leaves `destructiveHint` unset, which MCP
      // reads as "may be destructive" for anything not read-only — the honest
      // answer for a tool in somebody else's application that Pilae has not
      // classified, and what clients were told before.
      const declaresDelete = meta.destructiveAction !== null;
      server.registerTool(
        toolName,
        {
          // Sanitised and prefixed as untrusted when it was cached, and cleaned
          // again as it was read (`buildBrickTools`).
          description: String(tool.description ?? ""),
          inputSchema: fromJsonSchema(
            ((tool.inputSchema as { jsonSchema?: unknown })?.jsonSchema ?? {
              type: "object",
              properties: {},
            }) as never,
          ),
          annotations: {
            readOnlyHint: !declaresDelete && (meta.readOnlyHint || meta.readTool),
            ...(declaresDelete ? { destructiveHint: true } : {}),
          },
        },
        recorded(outcomes, toolName, async (rawArgs: unknown) => {
          const execute = tool.execute;
          if (!execute) return asToolResult({ ok: false, error: "Tool unavailable." });

          // Re-checked at call time, as for Pilae's own tools.
          const reach = decideScope(BRICK_REQUIREMENT, principal);
          if (!reach.ok) return refusedResult(reach);

          // A call matching the delete its recipe declares — dropping a
          // collection, removing items — needs what a Pilae delete needs: the
          // token's `pilae:destructive`, and a workspace that has not switched
          // destructive actions off. Decided on the call's own arguments, the
          // same exact match the console's policy runs, so the two surfaces
          // cannot disagree about which call deletes. The request gate has
          // already asked (and challenged a missing scope); this stands behind
          // it, on the arguments as the server parsed them. A delete made any
          // other way, or in an app Pilae has no recipe for, is not recognised
          // here either: it runs on `pilae:apps` like any other write, and the
          // app's own permissions are what stand in front of it.
          const deletes = brickCallRequirement(meta, rawArgs);
          if (deletes) {
            const decision = decideScope(deletes, principal);
            if (!decision.ok) return refusedResult(decision);
          }

          const output = await execute(
            (rawArgs ?? {}) as Record<string, unknown>,
            {
              toolCallId: toolName,
              messages: [],
              context: undefined,
            } as never,
          );
          return asToolResult(output);
        }),
      );
      registered += 1;
    }
  }

  return server;
}

/**
 * The handler, built fresh per request for the reason given above, with
 * PostHog's MCP analytics on the server it builds (`./analytics`).
 *
 * Each server gets its own `CallOutcomes`, made beside it and handed to
 * nothing but its handlers and its own analytics client, so a call's code and
 * route status can only ever ride on that request's `$mcp_tool_call`.
 */
export function mcpHandlerFor(options: McpServerOptions) {
  return createMcpHandler(async () => {
    const outcomes = options.analytics?.enabled ? new CallOutcomes() : undefined;
    const server = await buildMcpServer(options, outcomes);
    return (await instrumentMcpServer(server, { ...options, outcomes })) as never;
  });
}
