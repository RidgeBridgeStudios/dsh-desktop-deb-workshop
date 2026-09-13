export interface NimChatMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

export interface NimRequestBody {
  model?: string;
  messages?: NimChatMessage[];
  chat_template_kwargs?: Record<string, unknown>;
  [key: string]: unknown;
}

export declare const name: string;
export declare function isNimEndpoint(url: string | URL): boolean;
export declare function transformNimRequestBody(body: NimRequestBody): { body: NimRequestBody; modified: boolean };
export declare function apply(ctx?: any): void;
export declare function __resetForTests(): void;

declare const _default: {
  name: string;
  apply: typeof apply;
  isNimEndpoint: typeof isNimEndpoint;
  transformNimRequestBody: typeof transformNimRequestBody;
  __resetForTests: typeof __resetForTests;
};
export default _default;
