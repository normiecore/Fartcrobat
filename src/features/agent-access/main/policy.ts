// Whether agent access is on: the person's preference, unless the machine policy file decides
// (read by @main/policy, which saved passwords share).
import type { PolicyDecision } from '@main/policy'

export { currentPolicy, machinePolicyFile, readPolicy, type PolicyDecision } from '@main/policy'

export interface AgentAccessState {
  enabled: boolean
  /** Set when a policy file decides (the Preferences switch is then read-only). */
  policy: PolicyDecision | null
}

export function agentAccessState(
  preference: boolean | undefined,
  policy: PolicyDecision | null
): AgentAccessState {
  return { enabled: policy ? policy === 'enabled' : preference !== false, policy }
}
