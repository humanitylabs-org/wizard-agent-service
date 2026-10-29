# Diagnosed sign-in recovery — staging only

James's correction: a diagnosed sign-in failure has one fix path, never a known-failing Retry. Undiagnosed failures retain their existing controls. The shared failure card owns the explanation once. A fresh held owner request resumes once on its original model after sign-in; another failure never loops. Never change real logins or deploy to live.

Reuse:
- failure card: EXTEND web/core/chat-models.js WosModels.failureHtml diagnosed variant
- list recovery: EXTEND web/core/chat-power.js errorRow / openReconnect
- in-shell recovery window: REUSE web/core/links.js and web/core/bound-view.js
- held request: EXTEND server/run-queue.mjs DurableRunQueue source-linked retry; inherit immutable input, routing, attachments and idempotency; bound automatic recovery to six hours, current request, no owner stop, once across restart
- recovery status: EXTEND server/service.mjs protected read-only provider-recovery endpoint
- focused repair screen: EXTEND Troubleshooter web/index.html paintReconnect and appLink
- Back to chat and skin: REUSE web/core/app-client.js WizardApp.nav.back and WizardApp.theme

Only the isolated synthetic preview is changed. The fake connection page is labelled STAGING. Provider readiness is injectable in the rig; the service default reads the existing connection reader, never changes the selected provider or model. Status confirmation waits for the actual child run to complete, not merely a good account reading. Real-provider credential renewal and every agent-kind matrix remain separate integration assurance; this rig never exercises a real account.
