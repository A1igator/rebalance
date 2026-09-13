export type OpenCodeShareImportRequest = {
  cwd: string;
  sessionId: string;
  requestId: string;
  code: string;
  normalized: Record<string, unknown>;
  blocked?: undefined;
} | { blocked: string };

export function selectOpenCodeShareImportRequest(input: unknown, root?: string): OpenCodeShareImportRequest | null;
export function handleOpenCodeSharePrompt(input: unknown, overrides?: Record<string, unknown>): Promise<unknown>;
