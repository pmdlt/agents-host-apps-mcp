// Excerpt from a private codebase, shared for the Make Something Agents Want hackathon (README.md).
// Imports that point outside this folder are not included, so this does not build on its own.

import type { McpServer } from "@modelcontextprotocol/server";

import { lazy } from "../lib/lazy";
import {
  type Analytics,
  analyticsErrorCode,
  analyticsToolName,
  type Props,
  type ServerEvent,
} from "../lib/posthog";
import type { McpPrincipal } from "./principal";

/**
 * MCP analytics: PostHog's own `@posthog/mcp`, which is what fills PostHog's MCP
 * analytics screens (calls, clients, tool quality, the tools a client was
 * offered). Those screens read only the SDK's `$mcp_*` events.
 *
 * The SDK is handed a client that is not a PostHog client. Each event it
 * captures becomes a `ServerEvent` on the request's `Analytics`, so it goes
 * through the same door as everything else (src/lib/posthog.ts): the person and
 * the workspace come from the token's principal, never from the SDK; the vendor
 * filter and the length cap apply; and it leaves in the request's one batch,
 * which the analytics middleware sends after the response.
 *
 * The SDK records more than Pilae sends, so on the way:
 *
 *  - Only the three events those screens read survive. `$identify` (person
 *    properties are set at sign-in), `$exception` (errors go to Sentry) and the
 *    resource and prompt listings Pilae does not serve are dropped.
 *  - Only the properties in `MCP_PROPERTIES` survive. Gone are the call's
 *    arguments (`$mcp_parameters`) and result (`$mcp_response`), the error text
 *    (`$mcp_error_message`, which is the tool's own answer), the argument names
 *    (`$mcp_input_keys`) and the tool descriptions (an app's are its author's
 *    text).
 *  - A tool is named as it is everywhere else (`analyticsToolName`): a
 *    customer's app tool is `app_tool`, in a call and in a listing alike.
 *  - A call says how it ended as `http_status` and, when it failed, `code`,
 *    which only its handler knows: the status of the route the call reached,
 *    however it answered, and the code the client was handed. The handler
 *    records them (`CallOutcomes`) and they ride on that call's
 *    `$mcp_tool_call`, never as words. The console's tool spans report the
 *    same two by the same rules (src/agent/posthog-telemetry.ts).
 *  - Nothing is added to any tool and no result is changed: `context`,
 *    `captureModel` and `enableConversationId` are off, so a client sees the
 *    tool list it saw before.
 *
 * Sessions: every request builds a fresh server on a stateless transport, and
 * `createMcpHandler` answers 2025-era clients in a mode where the SDK's session
 * header never reaches them, so each request is its own `$session_id`.
 */

/** Loaded on the first instrumented request: no other request pays for it. */
const loadInstrument = lazy(async () => (await import("@posthog/mcp")).instrument);

type Instrument = Awaited<ReturnType<typeof loadInstrument>>;

/** The events PostHog's MCP analytics screens read. */
const MCP_EVENTS = new Set(["$mcp_tool_call", "$mcp_tools_list", "$mcp_initialize"]);

/**
 * The properties that survive: categorical values, counts, durations and the
 * client's own name for itself. Never anything a customer typed or a tool
 * answered.
 */
const MCP_PROPERTIES = new Set([
  "$mcp_interface",
  "$mcp_source",
  "$session_id",
  "$mcp_tool_name",
  "$mcp_listed_tool_names",
  "$mcp_duration_ms",
  "$mcp_is_error",
  "$mcp_error_type",
  "$mcp_server_name",
  "$mcp_server_version",
  "$mcp_server_build",
  "$mcp_client_name",
  "$mcp_client_version",
  "$mcp_client_user_agent",
  "$mcp_vendor_client",
  "$mcp_protocol_version",
  // Pilae's own, from `eventProperties` below.
  "surface",
  "client_host",
  // Pilae's own too, from the call's handler (`CallOutcomes`): a failure's
  // code and the HTTP status of the route a call reached, which
  // `toServerEvent` keeps only as such.
  "code",
  "http_status",
]);

/** The part of a PostHog client the SDK uses: `capture`, from its event sink. */
interface SdkCapture {
  event: string;
  properties?: Record<string, unknown>;
}

function scalarOf(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

/**
 * One SDK event as the `ServerEvent` Pilae sends, or null when it is not sent
 * at all. The person is the principal, whatever distinct id the SDK chose.
 */
export function toServerEvent(capture: SdkCapture, principal: McpPrincipal): ServerEvent | null {
  if (!MCP_EVENTS.has(capture.event)) return null;

  const properties: Props = {};
  for (const [key, value] of Object.entries(capture.properties ?? {})) {
    if (!MCP_PROPERTIES.has(key)) continue;
    if (key === "$mcp_tool_name") {
      if (typeof value === "string") properties[key] = analyticsToolName(value);
      continue;
    }
    if (key === "$mcp_listed_tool_names") {
      if (Array.isArray(value)) {
        const names = value.filter((name): name is string => typeof name === "string");
        properties[key] = [...new Set(names.map(analyticsToolName))];
      }
      continue;
    }
    if (key === "code") {
      // A code is all a failure may say about itself: a sentence is dropped.
      const code = analyticsErrorCode(value);
      if (code !== undefined) properties[key] = code;
      continue;
    }
    if (key === "http_status") {
      if (typeof value === "number" && Number.isInteger(value)) properties[key] = value;
      continue;
    }
    const scalar = scalarOf(value);
    if (scalar !== undefined) properties[key] = scalar;
  }

  return {
    event: capture.event,
    userId: principal.userId,
    organizationId: principal.organizationId,
    properties,
  };
}

/**
 * How one tool call ended, as its handler saw it (src/mcp/server.ts): when the
 * call reached one of Pilae's routes, that route's HTTP status, however it
 * answered, and for a failure the code the client was handed. Unchecked here:
 * `toServerEvent` keeps the code only when it looks like one, and the status
 * only as a number.
 */
export interface CallOutcome {
  code?: unknown;
  status?: number;
}

/**
 * The outcomes of one server's tool calls, held until each call's
 * `$mcp_tool_call` takes its own.
 *
 * The SDK builds that event around the handler, from the request and the
 * result, so what only the handler knows — the code and the route's status —
 * reaches it this way. A record is matched to its call by the tool's name, the
 * one thing the event and the handler share. The SDK captures only after the
 * handler has answered, so the record is always there first; a handler
 * records a success too, with its route's status or empty, so a failure's
 * record is never taken by the event of an earlier call that succeeded. Calls
 * of one tool are matched in the order they answered.
 *
 * One per server, and a server is built per request (`mcpHandlerFor`): only
 * that server's handlers write to it, and only the client handed to that same
 * server's SDK reads it. A record can never reach another request's event.
 */
export class CallOutcomes {
  readonly #byTool = new Map<string, CallOutcome[]>();

  /** A call of `toolName` answered, and this is how it ended. */
  record(toolName: string, outcome: CallOutcome): void {
    const queue = this.#byTool.get(toolName);
    if (queue) queue.push(outcome);
    else this.#byTool.set(toolName, [outcome]);
  }

  /** The oldest call of `toolName` whose outcome no event has taken yet. */
  take(toolName: string): CallOutcome | undefined {
    return this.#byTool.get(toolName)?.shift();
  }
}

/**
 * A `$mcp_tool_call` with its own call's outcome on it, as `code` and
 * `http_status`. Those two names are Pilae's alone: on a tool call, whatever
 * the SDK put under them is replaced, and dropped when there is no record.
 */
function withCallOutcome(capture: SdkCapture, outcomes: CallOutcomes | undefined): SdkCapture {
  if (capture.event !== "$mcp_tool_call") return capture;
  const toolName = capture.properties?.$mcp_tool_name;
  const outcome = typeof toolName === "string" ? outcomes?.take(toolName) : undefined;
  return {
    ...capture,
    properties: { ...capture.properties, code: outcome?.code, http_status: outcome?.status },
  };
}

/**
 * What the SDK is given in place of a PostHog client: for one request's
 * server, with that server's own `CallOutcomes`.
 */
export function mcpAnalyticsClient(
  analytics: Analytics,
  principal: McpPrincipal,
  outcomes?: CallOutcomes,
) {
  return {
    capture(capture: SdkCapture) {
      const event = toServerEvent(withCallOutcome(capture, outcomes), principal);
      if (event) analytics.capture(event);
    },
  };
}

/**
 * Which client made the call, as far as analytics is told: the host of a
 * Client ID Metadata Document (`claude.ai`), or "registered" for a dynamically
 * registered client, whose id is an opaque string.
 */
export function clientHostOf(clientId: string | null): string {
  if (!clientId) return "unknown";
  try {
    const url = new URL(clientId);
    return url.protocol === "https:" ? url.hostname : "registered";
  } catch {
    return "registered";
  }
}

/** The deploy's git sha as `$mcp_server_build`, which the SDK refuses outside 1–256 characters. */
function serverBuildOf(release: string | undefined): string | undefined {
  const value = release?.trim();
  return value && value.length <= 256 ? value : undefined;
}

/**
 * Instrument one request's server. A no-op when analytics is off, and never a
 * failure: a server the SDK cannot instrument is served as it is.
 * `outcomes` is the one its handlers record into (`buildMcpServer`).
 */
export async function instrumentMcpServer(
  server: McpServer,
  options: { env: Env; principal: McpPrincipal; analytics?: Analytics; outcomes?: CallOutcomes },
): Promise<McpServer> {
  const { env, principal, analytics, outcomes } = options;
  if (!analytics?.enabled) return server;
  try {
    const instrument = await loadInstrument();
    instrument(
      server,
      mcpAnalyticsClient(analytics, principal, outcomes) as unknown as Parameters<Instrument>[1],
      {
        context: false,
        captureModel: false,
        enableConversationId: false,
        enableExceptionAutocapture: false,
        serverBuild: serverBuildOf(env.SENTRY_RELEASE),
        eventProperties: () => ({ surface: "mcp", client_host: clientHostOf(principal.clientId) }),
      },
    );
  } catch (err) {
    console.warn({ message: "mcp_analytics_init_failed", error: String(err) });
  }
  return server;
}
