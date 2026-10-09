// TimeHero on Azure: everything one deployment needs, in one resource group.
//
//   App Service (Linux, Node 22)  ── runs `node server.js` from the standalone build
//   PostgreSQL Flexible Server    ── public endpoint, TLS only, firewalled to the
//                                    app's outbound addresses
//   Key Vault                     ── every secret; App Service reads them through
//                                    Key Vault references with its own identity
//   Deploy identity               ── federated with GitHub Actions (no stored
//                                    credential), for .github/workflows/deploy.yml
//   Application Insights          ── availability tests on /api/health and
//                                    /api/health/jobs, alerting by email
//   Log Analytics                 ── the app's console and HTTP logs and the
//                                    database's logs, kept logRetentionDays
//
// Nothing here is specific to one organization: everything that differs is a
// parameter. docs/AZURE-SETUP.md is the walkthrough, and example.bicepparam the
// starting point for an organization's own parameter file.
//
//   az deployment group create -g <group> -f infra/main.bicep -p infra/<org>.bicepparam

targetScope = 'resourceGroup'

// ─── Naming and place ──────────────────────────────────────────────────────

@description('Short name for this deployment, used in every resource name. The web app is reached at <name>.azurewebsites.net, so it must be globally unique. Lowercase letters, digits and hyphens.')
@minLength(3)
@maxLength(40)
param name string

param location string = resourceGroup().location

@description('The custom domain staff will use, e.g. time.example.org. Leave empty to use <name>.azurewebsites.net. Its DNS must already point here — see docs/AZURE-SETUP.md — or the deployment fails.')
param customDomain string = ''

// ─── Sizes ─────────────────────────────────────────────────────────────────

@description('App Service plan SKU. B1 is ample for ~100 staff; Always On needs Basic or above.')
param appServiceSku string = 'B1'

@description('PostgreSQL compute. Burstable B1ms is ample for ~100 staff.')
param postgresSku string = 'Standard_B1ms'

@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param postgresTier string = 'Burstable'

param postgresStorageGB int = 32

@description('Seconds between checks that the site is up. Each run from each location is billed, so a check every 5 minutes costs three times one every 15.')
@allowed([300, 600, 900])
param siteCheckSeconds int = 900

@description('Locations each availability test runs from, 2 to 4. An alert fires when two fail together, so 2 means both.')
@minValue(2)
@maxValue(4)
param availabilityLocations int = 2

@allowed(['16', '17'])
param postgresVersion string = '17'

@description('Point-in-time restore window. 35 is the most Azure allows; the cost is storage only.')
@minValue(7)
@maxValue(35)
param backupRetentionDays int = 35

@description('Copy backups to the paired region, so a regional outage cannot take them too. Can only be chosen when the server is created.')
param geoRedundantBackup bool = true

// ─── Database credentials ──────────────────────────────────────────────────

param postgresAdminLogin string = 'timehero'

@secure()
@description('Set once, at creation. Stored in Key Vault as part of DATABASE_URL; nobody needs to remember it.')
param postgresAdminPassword string

@description('The Key Vault secret the app\'s DATABASE_URL comes from. DATABASE-URL is the administrator, which migrations always use; name a secret holding a least-privilege role\'s URL to run the app as that instead — docs/AZURE-SETUP.md.')
param appDatabaseUrlSecret string = 'DATABASE-URL'

// ─── GitHub ────────────────────────────────────────────────────────────────

@description('owner/repo whose Actions may deploy, e.g. your-org/timehero.')
param githubRepository string

@description('The GitHub environment the deploy job runs in. Only that environment may use the deploy identity.')
param githubEnvironment string = 'production'

// ─── Alerts and logs ───────────────────────────────────────────────────────

@description('Who hears when the site is down or a scheduled job stops running.')
param alertEmails array

@description('Days the Log Analytics workspace keeps logs. 30 is included in the price; longer is billed per GB.')
@minValue(30)
@maxValue(730)
param logRetentionDays int = 30

// ─── Sign-in and mail (non-secret parts; secrets go in Key Vault) ──────────

@description('Entra app registration client id, or empty for no Microsoft sign-in.')
param entraClientId string = ''

@description('Entra tenant id (a GUID), needed with entraClientId.')
param entraTenantId string = ''

@description('Google OAuth client id, or empty for no Google sign-in.')
param googleClientId string = ''

param emailSignInLinks bool = false

@allowed(['', 'graph', 'smtp'])
@description('How mail leaves. graph needs the Entra registration; smtp needs the SMTP-URL secret. Empty sends none.')
param mailTransport string = ''

@description('Web Push public key (npx web-push generate-vapid-keys). Empty turns push off.')
param vapidPublicKey string = ''

@description('A contact for the push services: mailto:… or https://…')
param vapidSubject string = ''

// ─── Derived ───────────────────────────────────────────────────────────────

var suffix = uniqueString(resourceGroup().id, name)
var keyVaultName = take('kv-${replace(name, '-', '')}-${suffix}', 24)
var appUrl = empty(customDomain) ? 'https://${name}.azurewebsites.net' : 'https://${customDomain}'
var useEntra = !empty(entraClientId)
var useGoogle = !empty(googleClientId)
var usePush = !empty(vapidPublicKey)

// Built-in role definitions.
var roles = {
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  websiteContributor: 'de139f84-1756-47ae-9be6-808fbbe84772'
}

// ─── Monitoring ────────────────────────────────────────────────────────────

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: logRetentionDays
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${name}-insights'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
  }
}

// ─── Secrets ───────────────────────────────────────────────────────────────

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
  }
}

// The one secret this template can write: it knows every part of it. The rest
// (AUTH-SECRET, JOBS-SECRET, VAPID-PRIVATE-KEY and the sign-in and mail
// secrets) are set by hand once — see docs/AZURE-SETUP.md — so that a
// redeploy can never rotate them.
// Deleting the vault would stop the app at its next restart. Purge protection
// already keeps a deleted vault recoverable; the lock stops the deletion. It
// does not affect reading or writing secrets. Removing it needs Owner (or
// another role with Microsoft.Authorization/locks/*), as creating it does.
resource vaultLock 'Microsoft.Authorization/locks@2020-05-01' = {
  scope: vault
  name: 'do-not-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'Holds every TimeHero secret. Remove this lock deliberately before deleting the vault.'
  }
}

resource databaseUrl 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'DATABASE-URL'
  properties: {
    value: 'postgresql://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/${database.name}?sslmode=require'
  }
}

// ─── Database ──────────────────────────────────────────────────────────────

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${name}-db'
  location: location
  sku: { name: postgresSku, tier: postgresTier }
  properties: {
    version: postgresVersion
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: { storageSizeGB: postgresStorageGB, autoGrow: 'Enabled' }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: geoRedundantBackup ? 'Enabled' : 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
    authConfig: { activeDirectoryAuth: 'Disabled', passwordAuth: 'Enabled' }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'timehero'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

resource postgresDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: postgres
  name: 'to-log-analytics'
  properties: {
    workspaceId: logs.id
    logs: [{ category: 'PostgreSQLLogs', enabled: true }]
  }
}

// No lock on the server: a delete lock covers its child resources too, and
// the deploy workflow deletes the firewall rule it opened for the migration
// (as this template's own firewall module replaces the app's rules). Losing
// the server is covered by its backups instead — docs/RUNBOOK.md.

// ─── The app ───────────────────────────────────────────────────────────────

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${name}-plan'
  location: location
  kind: 'linux'
  sku: { name: appServiceSku }
  properties: { reserved: true }
}

/** An app setting that App Service resolves from Key Vault at startup. */
func secretRef(vaultName string, secret string) string =>
  '@Microsoft.KeyVault(VaultName=${vaultName};SecretName=${secret})'

var baseSettings = [
  { name: 'NODE_ENV', value: 'production' }
  // The standalone server listens on PORT (App Service sets it) and HOSTNAME;
  // App Service sets HOSTNAME to the container's name, which is not an
  // address the front end can reach, so bind every interface instead.
  { name: 'HOSTNAME', value: '0.0.0.0' }
  // The build happens in GitHub Actions; App Service only unzips it.
  { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
  { name: 'APP_URL', value: appUrl }
  // Auth.js builds callback URLs from this, and trusts the host because of it.
  { name: 'AUTH_URL', value: appUrl }
  { name: 'DATABASE_URL', value: secretRef(vault.name, appDatabaseUrlSecret) }
  { name: 'AUTH_SECRET', value: secretRef(vault.name, 'AUTH-SECRET') }
  { name: 'JOBS_SECRET', value: secretRef(vault.name, 'JOBS-SECRET') }
  { name: 'AUTH_EMAIL_LINKS', value: string(emailSignInLinks) }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
  { name: 'ApplicationInsightsAgent_EXTENSION_VERSION', value: '~3' }
]

var entraSettings = useEntra
  ? [
      { name: 'AUTH_MICROSOFT_ENTRA_ID_ID', value: entraClientId }
      { name: 'AUTH_MICROSOFT_ENTRA_ID_ISSUER', value: '${environment().authentication.loginEndpoint}${entraTenantId}/v2.0' }
      { name: 'AUTH_MICROSOFT_ENTRA_ID_SECRET', value: secretRef(vault.name, 'ENTRA-CLIENT-SECRET') }
    ]
  : []

var googleSettings = useGoogle
  ? [
      { name: 'AUTH_GOOGLE_ID', value: googleClientId }
      { name: 'AUTH_GOOGLE_SECRET', value: secretRef(vault.name, 'GOOGLE-CLIENT-SECRET') }
    ]
  : []

var mailSettings = concat(
  empty(mailTransport) ? [] : [{ name: 'MAIL_TRANSPORT', value: mailTransport }],
  mailTransport == 'smtp' ? [{ name: 'SMTP_URL', value: secretRef(vault.name, 'SMTP-URL') }] : []
)

var pushSettings = usePush
  ? [
      { name: 'VAPID_PUBLIC_KEY', value: vapidPublicKey }
      { name: 'VAPID_SUBJECT', value: vapidSubject }
      { name: 'VAPID_PRIVATE_KEY', value: secretRef(vault.name, 'VAPID-PRIVATE-KEY') }
    ]
  : []

resource app 'Microsoft.Web/sites@2023-12-01' = {
  name: name
  location: location
  kind: 'app,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    keyVaultReferenceIdentity: 'SystemAssigned'
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      appCommandLine: 'node server.js'
      alwaysOn: true
      healthCheckPath: '/api/health'
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: concat(baseSettings, entraSettings, googleSettings, mailSettings, pushSettings)
    }
  }
}

// Deploys sign in with Entra ID (the deploy identity), never a publishing
// username and password, so neither Kudu nor FTP accepts one.
resource noBasicAuthScm 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: app
  name: 'scm'
  properties: { allow: false }
}

resource noBasicAuthFtp 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: app
  name: 'ftp'
  properties: { allow: false }
}

resource appDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: app
  name: 'to-log-analytics'
  properties: {
    workspaceId: logs.id
    logs: [
      { category: 'AppServiceConsoleLogs', enabled: true }
      { category: 'AppServiceHTTPLogs', enabled: true }
      { category: 'AppServiceAppLogs', enabled: true }
    ]
  }
}

resource appReadsSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, app.id, roles.keyVaultSecretsUser)
  properties: {
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsUser)
  }
}

// Postgres admits the app's outbound addresses and nothing else. They are
// only known once the app exists, so the rules are a module: its loop is
// sized when it runs, not when this file is compiled.
module appFirewall 'modules/postgres-firewall.bicep' = {
  name: 'postgres-firewall'
  params: {
    serverName: postgres.name
    addresses: split(app.properties.possibleOutboundIpAddresses, ',')
  }
}

// ─── Custom domain ─────────────────────────────────────────────────────────

module domain 'modules/custom-domain.bicep' = if (!empty(customDomain)) {
  name: 'custom-domain'
  params: {
    appName: app.name
    planId: plan.id
    location: location
    hostname: customDomain
  }
}

// ─── Deploying from GitHub ─────────────────────────────────────────────────

resource deployer 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${name}-deploy'
  location: location
}

// No secret: GitHub proves which repository and environment a run belongs
// to, and Azure accepts exactly this one.
resource deployerTrustsGitHub 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: deployer
  name: 'github-${githubEnvironment}'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${githubRepository}:environment:${githubEnvironment}'
    audiences: ['api://AzureADTokenExchange']
  }
}

// Deploy the app.
resource deployerDeploysApp 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: app
  name: guid(app.id, deployer.id, roles.websiteContributor)
  properties: {
    principalId: deployer.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.websiteContributor)
  }
}

// Read DATABASE-URL, to run migrations before the new code starts.
resource deployerReadsSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, deployer.id, roles.keyVaultSecretsUser)
  properties: {
    principalId: deployer.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsUser)
  }
}

// Open the firewall to the runner for the length of the migration, and close
// it again: firewall rules and nothing else on the server. Earlier versions of
// this template granted Contributor here; a redeploy does not remove that
// assignment — docs/AZURE-SETUP.md, "Upgrading an earlier deployment".
resource firewallOperator 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, name, 'postgres-firewall-operator')
  properties: {
    roleName: 'TimeHero Postgres firewall operator (${name}, ${suffix})'
    description: 'Create and delete firewall rules on the TimeHero database server, for the deploy workflow.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.DBforPostgreSQL/flexibleServers/read'
          'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules/*'
          // The CLI polls the create and delete until they finish.
          'Microsoft.DBforPostgreSQL/locations/azureAsyncOperation/read'
          'Microsoft.DBforPostgreSQL/locations/operationResults/read'
        ]
        notActions: []
      }
    ]
    assignableScopes: [resourceGroup().id]
  }
}

resource deployerOpensFirewall 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: postgres
  name: guid(postgres.id, deployer.id, firewallOperator.id)
  properties: {
    principalId: deployer.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: firewallOperator.id
  }
}

// ─── Alerts ────────────────────────────────────────────────────────────────

resource responders 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${name}-responders'
  location: 'global'
  properties: {
    groupShortName: take(replace(name, '-', ''), 12)
    enabled: true
    emailReceivers: [
      for (email, i) in alertEmails: {
        name: 'email-${i}'
        emailAddress: email
        useCommonAlertSchema: true
      }
    ]
  }
}

module siteUp 'modules/availability.bicep' = {
  name: 'availability-site'
  params: {
    name: '${name}-site-up'
    location: location
    insightsId: insights.id
    url: '${appUrl}/api/health'
    frequencySeconds: siteCheckSeconds
    locationCount: availabilityLocations
    description: 'TimeHero is not answering, or cannot reach its database.'
    actionGroupId: responders.id
  }
}

module jobsOnSchedule 'modules/availability.bicep' = {
  name: 'availability-jobs'
  params: {
    name: '${name}-jobs-on-schedule'
    location: location
    insightsId: insights.id
    url: '${appUrl}/api/health/jobs'
    frequencySeconds: 900
    locationCount: availabilityLocations
    description: 'A TimeHero scheduled job has not succeeded on schedule. Admin → Jobs names it; run the missed dates once the workflow is fixed.'
    actionGroupId: responders.id
  }
}

// ─── What the next steps need ──────────────────────────────────────────────

output appName string = app.name
output appUrl string = appUrl
output defaultHostName string = app.properties.defaultHostName
@description('For the asuid TXT record that proves the custom domain is yours.')
output customDomainVerificationId string = app.properties.customDomainVerificationId
output keyVaultName string = vault.name
output postgresServerName string = postgres.name
output postgresHost string = postgres.properties.fullyQualifiedDomainName
@description('GitHub repository variable AZURE_CLIENT_ID.')
output deployClientId string = deployer.properties.clientId
@description('GitHub repository variable AZURE_TENANT_ID.')
output tenantId string = subscription().tenantId
@description('GitHub repository variable AZURE_SUBSCRIPTION_ID.')
output subscriptionId string = subscription().subscriptionId
output resourceGroup string = resourceGroup().name
