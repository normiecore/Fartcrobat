// Whether agent access is on: the person's preference, unless a machine policy decides (read by
// @main/policy, which saved passwords share: HKLM on Windows, a policy file elsewhere).
import { failClosed, machineReadings, readPolicy, type PolicyDecision } from '@main/policy'

export { machinePolicyFile, readPolicy, type PolicyDecision } from '@main/policy'

export interface AgentAccessState {
  enabled: boolean
  /** Set when a machine policy decides (the Preferences switch is then read-only). */
  policy: PolicyDecision | null
}

/** The machine's policy on agent access, failing closed (`file` replaces it in tests). */
export async function machinePolicy(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  file?: string
): Promise<PolicyDecision | null> {
  return failClosed((await machineReadings({ platform, env, file })).agentAccess)
}

/**
 * The policy that applies. The machine's comes first: FARTCROBAT_POLICY_FILE only exists for tests
 * and never overrides what an administrator set.
 */
export function currentPolicy(
  machine: PolicyDecision | null,
  env: NodeJS.ProcessEnv = process.env
): PolicyDecision | null {
  if (machine) return machine
  return env.FARTCROBAT_POLICY_FILE ? readPolicy(env.FARTCROBAT_POLICY_FILE) : null
}

export function agentAccessState(
  preference: boolean | undefined,
  policy: PolicyDecision | null
): AgentAccessState {
  return { enabled: policy ? policy === 'enabled' : preference !== false, policy }
}
