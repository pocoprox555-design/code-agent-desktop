import path from 'node:path'

export const RUNTIME_POLICY_REVISION = 'sandbox-policy-2'

export interface RuntimeMarker {
  marker: string
  version: string
  policyRevision: string
  channel: 'dev' | 'packaged'
  appPath: string
  mainDir: string
}

export function createRuntimeMarker(input: { version: string; isPackaged: boolean; appPath: string; mainDir: string }): RuntimeMarker {
  const channel = input.isPackaged ? 'packaged' : 'dev'
  const appPath = path.resolve(input.appPath)
  const mainDir = path.resolve(input.mainDir)
  return { marker: `code-agent/${input.version}/${channel}/${RUNTIME_POLICY_REVISION}/${path.basename(appPath)}/${path.basename(mainDir)}`, version: input.version, policyRevision: RUNTIME_POLICY_REVISION, channel, appPath, mainDir }
}
