// Locked stream-json event shapes from probe run 2026-05-22.
// These types match claude --output-format stream-json --verbose v2.1.133.
// Parser in packages/core/src/adapters/ must handle all variants below.

export interface StreamInitEvent {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  tools: string[];
  mcp_servers: Array<{ name: string; status: string }>;
  model: string;
  permissionMode: string;
  claude_code_version: string;
  uuid: string;
}

export interface StreamRateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info: {
    status: string;
    resetsAt: number;
    rateLimitType: string;
  };
  uuid: string;
  session_id: string;
}

// Content blocks inside an assistant message
export type AssistantContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; caller: { type: string } };

export interface StreamAssistantEvent {
  type: "assistant";
  message: {
    model: string;
    id: string;
    role: "assistant";
    content: AssistantContentBlock[];
    stop_reason: string | null;
    usage: {
      input_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      output_tokens: number;
    };
  };
  parent_tool_use_id: string | null;
  session_id: string;
  uuid: string;
}

// Tool result content inside a user message
export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

export interface StreamUserEvent {
  type: "user";
  message: {
    role: "user";
    content: ToolResultContent[];
  };
  parent_tool_use_id: string | null;
  session_id: string;
  uuid: string;
  timestamp: string;
  // structured breakdown for Bash tool results
  tool_use_result:
    | {
        stdout: string;
        stderr: string;
        interrupted: boolean;
        isImage: boolean;
        noOutputExpected: boolean;
      }
    | string; // plain string for non-Bash tool errors
}

export interface StreamResultEvent {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  api_error_status: unknown | null;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  stop_reason: string;
  session_id: string;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
    server_tool_use: { web_search_requests: number; web_fetch_requests: number };
  };
  permission_denials: unknown[];
  terminal_reason: string;
  uuid: string;
}

export type StreamEvent =
  | StreamInitEvent
  | StreamRateLimitEvent
  | StreamAssistantEvent
  | StreamUserEvent
  | StreamResultEvent;
