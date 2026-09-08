import { createCloudflareAccessVerifier, createWizardServer } from './service.mjs'

const key = process.env.WIZARD_HERMES_API_KEY
if (!key) {
  process.stderr.write('WIZARD_HERMES_API_KEY is required; the service was not started.\n')
  process.exit(1)
}

const host = process.env.WIZARD_HOST || '127.0.0.1'
if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
  process.stderr.write('WIZARD_HOST must be a loopback address.\n')
  process.exit(1)
}

const port = Number(process.env.WIZARD_PORT || 8787)
const requireAccess = process.env.WIZARD_REQUIRE_CF_ACCESS !== '0'
const accessVerifier = requireAccess ? createCloudflareAccessVerifier({
  teamDomain: process.env.WIZARD_ACCESS_TEAM_DOMAIN,
  audience: process.env.WIZARD_ACCESS_AUDIENCE,
  jwksUrl: process.env.WIZARD_ACCESS_JWKS_URL,
}) : undefined
const server = createWizardServer({
  distDir: process.env.WIZARD_STATIC_DIR || '.ui-live',
  upstreamOrigin: process.env.HERMES_ORIGIN || 'http://127.0.0.1:8642',
  hermesKey: key,
  inboxOrigin: process.env.WIZARD_INBOX_ORIGIN || 'http://127.0.0.1:8941',
  inboxToken: process.env.WIZARD_INBOX_INTERNAL_TOKEN || '',
  inboxTrustedRoot: process.env.WIZARD_INBOX_TRUSTED_ROOT || '',
  operatorWorkerStatePath: process.env.WIZARD_OPERATOR_STATE_PATH || '',
  requireAccess,
  accessVerifier,
  operatorWorkerModel: 'glm-5-3',
})
server.listen(port, host, () => process.stdout.write(`Wizard listening on ${host}:${port}\n`))
