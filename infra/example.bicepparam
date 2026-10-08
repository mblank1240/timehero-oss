// Parameters for another organization's deployment. Copy to <org>.bicepparam,
// fill in, and deploy:
//
//   export POSTGRES_ADMIN_PASSWORD="$(openssl rand -base64 30)"
//   az deployment group create -g <group> -f infra/main.bicep -p infra/<org>.bicepparam
//
// docs/AZURE-SETUP.md walks through every step, including the secrets this
// file deliberately does not hold.

using 'main.bicep'

param name = 'timehero-example'
param customDomain = '' // e.g. 'time.example.org', once its DNS records exist

param postgresAdminPassword = readEnvironmentVariable('POSTGRES_ADMIN_PASSWORD')

param githubRepository = 'your-org/timehero'
param alertEmails = ['it@example.org']

// Sign-in: at least one of these, or emailed links with a mail transport.
param entraClientId = ''
param entraTenantId = ''
param googleClientId = ''
param emailSignInLinks = false
param mailTransport = ''

// Web Push. Generate the pair once and keep it: a new pair silently
// unsubscribes every browser.
param vapidPublicKey = ''
param vapidSubject = ''
