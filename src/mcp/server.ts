// Excerpt from a private codebase, shared for the Make Something Agents Want hackathon (README.md).
// Imports that point outside this folder are not included, so this does not build on its own.

import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import type { ToolSet } from "ai";

import { buildWorkflowsGuideTool } from "../agent/knowledge/workflows";
import { buildBrickTools } from "../agent/mcp-tools";
import { type createSelfFetchContext, selfFetch } from "../agent/self-fetch";
import { TOOL_META, type ToolMeta } from "../agent/tools/generated";
import { buildHandwrittenTools } from "../agent/tools/handwritten";
import { HANDWRITTEN_TOOL_META, type HandwrittenToolMeta } from "../agent/tools/handwritten-meta";
import { createDb } from "../db/client";
import type { Analytics } from "../lib/posthog";
import { API_VERSION_PREFIX } from "../lib/version";
import { instrumentMcpServer } from "./analytics";
import type { McpPrincipal } from "./principal";
import { BRICK_SCOPE, decideScope, scopeForTool } from "./scopes";

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
 * remote client has neither, so the control is the token's scope intersected
 * with the caller's live role — decided before the tool is ever invoked.
 */

/** No tool list is worth an unbounded registration loop. */
const MAX_BRICK_TOOLS = 60;

export interface McpServerOptions {
  env: Env;
  principal: McpPrincipal;
  ctx: ReturnType<typeof createSelfFetchContext>;
  /** The request's product analytics: PostHog's MCP events (`./analytics`). */
  analytics?: Analytics;
}

/**
 * Which Pilae tools this caller may see.
 *
 * Hidden BEFORE registration rather than refused on call, because a tool list is
 * a promise: an MCP client shows `pilae_services_delete` to its user, who asks
 * for it, and only then learns it was never possible. Advertising only what can
 * actually be called is the honest version, and it also means a member's client
 * never displays a destructive tool at all.
 */
export function visibleTools(principal: McpPrincipal): ToolMeta[] {
  return TOOL_META.filter((meta) => {
    if (meta.hidden) return false;
    return decideScope(scopeForTool(meta), principal.scopes, principal.orgRole).ok;
  });
}

/**
 * The hand-written tools a remote client is offered as well: the workflow ones
 * only.
 *
 * The workflow tools' descriptions, which both surfaces share, send the model
 * to the guide and to these two readers. Without them a client could start a
 * test run and never see what it printed or returned, and would be told to read
 * a guide that is not there. The readers wrap routes that are hidden on both
 * surfaces for the same reason on both: they hand back program output, which
 * reaches a model only redacted and marked untrusted. Every other hand-written
 * tool stays console-only until it is decided for this surface on its own.
 */
export const REMOTE_HANDWRITTEN_META: ReadonlyMap<string, HandwrittenToolMeta> = new Map(
  ["pilae_workflows_guide", "pilae_workflows_run_logs", "pilae_workflows_run_result"].flatMap(
    (name) => {
      const meta = HANDWRITTEN_TOOL_META.get(name);
      return meta ? [[name, meta] as const] : [];
    },
  ),
);

/** Which of those this caller may see, by the same rule as `visibleTools`. */
export function visibleHandwrittenTools(principal: McpPrincipal): HandwrittenToolMeta[] {
  return [...REMOTE_HANDWRITTEN_META.values()].filter(
    (meta) => decideScope(scopeForTool(meta), principal.scopes, principal.orgRole).ok,
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

/**
 * A tool's own output as a result, marked an error whenever the tool failed.
 *
 * Failure is read the way the console's accounting reads it: Pilae's
 * `ok: false` — a refusal, a connection that has gone, an app at its licence
 * cap, an app that could not be reached — or the app's own `isError`, bare or
 * under `app` when Pilae put a notice beside it. Without the flag a client
 * takes the refusal for a success and carries on as though the write landed.
 */
function asToolResult(output: unknown) {
  const { ok, isError, app } = (output && typeof output === "object" ? output : {}) as {
    ok?: unknown;
    isError?: unknown;
    app?: { isError?: unknown };
  };
  return asResult(output, ok === false || isError === true || app?.isError === true);
}

/**
 * Build the server for one request.
 *
 * Per request, not per process: the tool list depends on who is asking and what
 * their role is right now, and a server built once and reused would keep
 * offering an owner's tools to whoever connected next.
 */
export async function buildMcpServer(options: McpServerOptions): Promise<McpServer> {
  const { env, principal, ctx } = options;
  const server = new McpServer({ name: "pilae", version: "1.0.0" });

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
      async (rawArgs: unknown) => {
        const args = (rawArgs ?? {}) as Record<string, unknown>;
        // Re-checked at call time as well as at registration. Registration
        // decided what to ADVERTISE; this decides what may RUN, and the two
        // must not be able to disagree — a client can call a name it was never
        // offered.
        const decision = decideScope(scopeForTool(meta), principal.scopes, principal.orgRole);
        if (!decision.ok) {
          return asResult(
            { ok: false, error: "This token does not permit that action.", code: decision.kind },
            true,
          );
        }

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
          ? asResult(result.data)
          : asResult({ ok: false, error: result.error, code: result.code }, true);
      },
    );
  }

  // The workflow guide and run readers (`REMOTE_HANDWRITTEN_META`). Built
  // with the console's own constructors, so both surfaces run the same code;
  // their self-calls carry this caller, exactly like the routes above.
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
      async (rawArgs: unknown) => {
        // Re-checked at call time, as for the routes above.
        const decision = decideScope(scopeForTool(meta), principal.scopes, principal.orgRole);
        if (!decision.ok) {
          return asResult(
            { ok: false, error: "This token does not permit that action.", code: decision.kind },
            true,
          );
        }
        const output = await execute(
          (rawArgs ?? {}) as never,
          {
            toolCallId: meta.name,
            messages: [],
          } as never,
        );
        return asToolResult(output);
      },
    );
  }

  // The customer's own applications, if the token was granted that scope.
  if (principal.scopes.has(BRICK_SCOPE)) {
    const bricks = await buildBrickTools({
      db: createDb(env.DB),
      organizationId: principal.organizationId,
    });

    let registered = 0;
    for (const [toolName, meta] of bricks.meta) {
      if (registered >= MAX_BRICK_TOOLS) break;
      const tool = bricks.tools[toolName];
      if (!tool) continue;

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
          annotations: { readOnlyHint: meta.readOnlyHint },
        },
        async (rawArgs: unknown) => {
          const execute = tool.execute;
          if (!execute) return asResult({ ok: false, error: "Tool unavailable." }, true);
          const output = await execute(
            (rawArgs ?? {}) as Record<string, unknown>,
            {
              toolCallId: toolName,
              messages: [],
              context: undefined,
            } as never,
          );
          return asToolResult(output);
        },
      );
      registered += 1;
    }
  }

  return server;
}

/**
 * The handler, built fresh per request for the reason given above, with
 * PostHog's MCP analytics on the server it builds (`./analytics`).
 */
export function mcpHandlerFor(options: McpServerOptions) {
  return createMcpHandler(
    async () => (await instrumentMcpServer(await buildMcpServer(options), options)) as never,
  );
}
