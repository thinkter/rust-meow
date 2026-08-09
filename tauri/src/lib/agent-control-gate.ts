import type { AgentControlState } from "./types";

export interface AgentControlGateClient {
  getAgentControlState(): Promise<{ state: AgentControlState | null }>;
  saveAgentSettings(
    enabled: boolean,
    alias: string,
    codexPath: string,
  ): Promise<{ state: AgentControlState | null }>;
}

/** Missing and malformed stored values remain opt-out across upgrades. */
export function isAgentControlExperimentEnabled(value: unknown): boolean {
  return value === true;
}

/**
 * A hidden controller must not remain active in the backend. Preserve its
 * configuration so opting back in only requires an explicit Enable click.
 */
export async function disableAgentControlIfNeeded(
  client: AgentControlGateClient,
): Promise<boolean> {
  const response = await client.getAgentControlState();
  const settings = response.state?.settings;
  if (!settings?.enabled) return false;

  await client.saveAgentSettings(false, settings.alias || "meow", settings.codexPath || "codex");
  return true;
}
