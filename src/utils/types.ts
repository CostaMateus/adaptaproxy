export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
  description?: string;
}

export interface FunctionToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: JsonSchema;
    strict?: boolean;
  };
}

/** Tool choice options */
export type ToolChoice = 'auto' | 'none' | 'required' | {
  type: 'function';
  function: { name: string };
};

// --- Message Types ---

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface MessageToolCall {
  id: string;
  type: 'function';
  function: ToolCallFunction;
}

export interface Message {
  role: string;
  content: string | null;
  /** Present on assistant messages that invoked tools */
  tool_calls?: MessageToolCall[];
  /** Present on tool/function response messages to link back to a call */
  tool_call_id?: string;
  /** Present on tool/function response messages */
  name?: string;
  /** Reasoning content for thinking models */
  reasoning_content?: string;
}

// --- Request Types ---

export interface OpenAIRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  metadata?: {
    adapta_chat_id?: string;
    adapta_session_key?: string;
    adapta_chat_mode?: 'reuse' | 'new' | 'specific';
    adapta_new_chat?: boolean;
    adapta_user_key?: string;
    adapta_project_name?: string;
    adapta_folder_id?: string;
    adapta_prompt_mode?: 'full' | 'structured' | 'last_user';
    [key: string]: unknown;
  };
  tools?: FunctionToolDefinition[];
  tool_choice?: ToolChoice;
  stream_options?: {
    include_usage?: boolean;
  };
}

// --- Response Types ---

export interface ToolCall {
  index: number;
  id?: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChoiceDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCall[];
}

export interface Choice {
  index: number;
  delta?: ChoiceDelta;
  message?: ChoiceDelta;
  finish_reason: string | null;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens: number;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Choice[];
  usage?: Usage;
}
