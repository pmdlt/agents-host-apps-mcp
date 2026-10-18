// Excerpt from a private codebase, shared for the Make Something Agents Want hackathon (README.md).
// Imports that point outside this folder are not included, so this does not build on its own.

import type { McpServer } from "@modelcontextprotocol/server";

import { lazy } from "../lib/lazy";
import { type Analytics, analyticsToolName, type Props, type ServerEvent } from "../lib/posthog";
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

/** What the SDK is given in place of a PostHog client. */
export function mcpAnalyticsClient(analytics: Analytics, principal: McpPrincipal) {
  return {
    capture(capture: SdkCapture) {
      const event = toServerEvent(capture, principal);
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
 */
export async function instrumentMcpServer(
  server: McpServer,
  options: { env: Env; principal: McpPrincipal; analytics?: Analytics },
): Promise<McpServer> {
  const { env, principal, analytics } = options;
  if (!analytics?.enabled) return server;
  try {
    const instrument = await loadInstrument();
    instrument(
      server,
      mcpAnalyticsClient(analytics, principal) as unknown as Parameters<Instrument>[1],
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
