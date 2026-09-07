export interface CompanionViewRequest { url: string; rootDir: string; sessionId: string; }
export type CompanionPresentation = { host: 'cmux' | 'host'; opened: boolean; reused?: boolean; reason?: string };
export interface CompanionOverrides {
  env?: NodeJS.ProcessEnv;
  command?: string;
  execute?: (command: string, args: string[], options: {
    env: NodeJS.ProcessEnv; timeout: number; killSignal: string; maxBuffer: number; encoding: string; windowsHide: boolean;
  }) => Promise<{ stdout: string }>;
}
export function openCompanionView(request: CompanionViewRequest, overrides?: CompanionOverrides): Promise<CompanionPresentation>;
