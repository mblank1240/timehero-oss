# Azure setup

TimeHero runs on Azure App Service with Azure Database for PostgreSQL. All of
it is described in `infra/main.bicep`. One command creates it, and a re-run
changes only what differs.

If someone else owns your organization's Azure subscription, Part 1 is the
request to send them. Part 2 is what happens after they say yes. Part 3 covers the web
address, which works the same way for any organization deploying its own copy.

---

## Part 1: The request to send to whoever owns the subscription

> **Subject: Azure resource group request for the staff time-off system**
>
> We're ready to put TimeHero, the staff PTO, sick leave, comp time and
> timesheet system, into production. It needs a small footprint in the
> organization's Azure subscription:
>
> | | |
> |---|---|
> | A resource group | `rg-timehero`, in **East US 2** (or whichever region you prefer) |
> | Access to it | **Owner** on that resource group only, for `<OUR-ACCOUNT>` |
> | Resource providers registered | `Microsoft.Web`, `Microsoft.DBforPostgreSQL`, `Microsoft.KeyVault`, `Microsoft.Insights`, `Microsoft.OperationalInsights`, `Microsoft.ManagedIdentity`, `Microsoft.AlertsManagement` (most are already registered on any subscription that has used them) |
>
> **Why Owner and not Contributor:** the deployment grants the app its own
> identity read access to its Key Vault, and grants the GitHub deploy
> identity rights over the app. Creating those role assignments needs Owner,
> or Contributor plus Role Based Access Control Administrator. The access is
> limited to this resource group either way.
>
> **What goes in it:** one App Service plan (Basic B1, Linux), one web app,
> one PostgreSQL Flexible Server (Burstable B1ms, 32 GB, 35-day
> geo-redundant backups), a Key Vault, a managed identity, and Application
> Insights with two availability tests. It is defined in code
> (`infra/main.bicep` in the repository) and can be reviewed before anything
> is created.
>
> **Cost:** roughly $35 to $50 a month at list prices, mostly the web app and
> the database. Please check it in the Azure pricing calculator against our
> agreement. A budget alert on the resource group would be welcome.
>
> **Alternative, if you'd rather keep Owner:** you run the one deployment
> command yourself and send back its outputs. Day-to-day deploys then come
> from GitHub Actions and need nothing more from you.
>
> No secrets need to change hands. GitHub signs in to Azure with a federated
> identity scoped to this repository, and the database password is generated
> at deployment time and kept in the Key Vault.

Fill in `<OUR-ACCOUNT>` before sending.

---

## Part 2: Deploying, once you have access

You need the Azure CLI (`az`, which includes Bicep) and `openssl`. Sign in
with `az login`.

### 1. Fill in the parameters

Copy `infra/example.bicepparam` to `infra/<org>.bicepparam`. The file holds no secrets. Fill in:

- `entraClientId` / `entraTenantId`, from the registration in
  `docs/ENTRA-SETUP.md`. **The app will not start in production with no way
  to sign in**, so Microsoft or Google sign-in must be filled in before the
  first deploy of the code. The infrastructure itself can be created before.
- `mailTransport = 'graph'` and `emailSignInLinks = true` once Entra is in.
- `vapidPublicKey`. Generate the pair once with `npx web-push generate-vapid-keys`.
  The private half goes in Key Vault in step 3. **Keep the pair for good:** a new
  pair silently unsubscribes every browser.
- Leave `customDomain` empty for the first deployment (see Part 3).

### 2. Create everything

```bash
export POSTGRES_ADMIN_PASSWORD="$(openssl rand -base64 30)"
az deployment group create -g rg-timehero \
  -f infra/main.bicep -p infra/<org>.bicepparam \
  --query properties.outputs
```

The password goes straight into the `DATABASE-URL` secret in Key Vault.
Nobody needs to remember it. Every re-run needs a value, though, and **a
different value changes the database password**, and the secret with it.
The running app keeps the old password until it restarts, so either re-run
with the same password (read it back out of `DATABASE-URL`), or restart the
app immediately after.

Keep the outputs. Steps 3 and 4 use them.

The **jobs alert fires straight away**. Nothing has run yet, and that is
correct; it clears once the scheduled jobs have each run once (step 5).

### 3. Put the secrets in Key Vault

Grant yourself **Key Vault Secrets Officer** on the vault (the deployment does
not; you are Owner and can). Then:

```bash
VAULT=<keyVaultName output>
az keyvault secret set --vault-name $VAULT --name AUTH-SECRET  --value "$(openssl rand -base64 33)"
az keyvault secret set --vault-name $VAULT --name JOBS-SECRET  --value "$(openssl rand -hex 32)"
az keyvault secret set --vault-name $VAULT --name VAPID-PRIVATE-KEY    --value "<private key>"
az keyvault secret set --vault-name $VAULT --name ENTRA-CLIENT-SECRET  --value "<client secret value>"
# Only if used:
az keyvault secret set --vault-name $VAULT --name GOOGLE-CLIENT-SECRET --value "<…>"
az keyvault secret set --vault-name $VAULT --name SMTP-URL             --value "smtps://…"
```

The template writes only `DATABASE-URL`. These are set by hand, once, so that
a redeploy can never rotate them. Restart the web app after setting them
(`az webapp restart -g rg-timehero -n <appName>`). App Service reads Key Vault
references at startup.

### 4. Connect GitHub

In the repository's **Settings → Environments**, create `production`. Adding
yourself as a required reviewer means no deploy happens without a click.
Then add these **variables** (in the environment or the repository):

| Variable | Value |
|---|---|
| `AZURE_CLIENT_ID` | `deployClientId` output |
| `AZURE_TENANT_ID` | `tenantId` output |
| `AZURE_SUBSCRIPTION_ID` | `subscriptionId` output |
| `AZURE_RESOURCE_GROUP` | `resourceGroup` output |
| `AZURE_WEBAPP_NAME` | `appName` output |
| `AZURE_KEY_VAULT` | `keyVaultName` output |
| `AZURE_POSTGRES_SERVER` | `postgresServerName` output |
| `APP_BASE_URL` | `appUrl` output, e.g. `https://timehero-example.azurewebsites.net` |

Add one **secret**, `JOBS_SECRET`, with the same value as the `JOBS-SECRET`
in Key Vault. The scheduled-jobs workflow sends it.

### 5. First deploy

**Actions → Deploy → Run workflow.** It builds, opens the database firewall
to the runner, runs the migrations, closes the firewall again, deploys, and
checks `/api/health`. After that, every merge to `main` deploys itself once
CI passes.

The scheduled jobs (`jobs.yml`) start on their next cron tick now that
`APP_BASE_URL` and `JOBS_SECRET` exist. Loading the configuration and the
real employees is the next step: `docs/GO-LIVE.md`.

---

## Part 3: The web address

The address is configuration, not code. Everything that has to agree on it
reads `APP_URL`, which the template derives from `customDomain`:

| Uses the address | Where it is set |
|---|---|
| Links in emails, the Microsoft consent redirect | `APP_URL`, set by the template |
| Auth.js callback URLs | `AUTH_URL`, set by the template |
| The availability tests | built from the same value by the template |
| Scheduled jobs | `APP_BASE_URL` in GitHub, by hand |
| Microsoft sign-in | redirect URIs in the Entra registration, by the tenant owner |
| Google sign-in | authorized redirect URI in Google Cloud Console, by hand |

Until a custom domain is set up, the address is
`https://<name>.azurewebsites.net` and everything works there.

### Moving to your own domain

A subdomain of your organization's own, such as `time.example.org`.

1. **DNS.** With whoever runs the domain's DNS, create two records:

   | Type | Name | Value |
   |---|---|---|
   | CNAME | `time` | `<defaultHostName output>`, e.g. `timehero-example.azurewebsites.net` |
   | TXT | `asuid.time` | `<customDomainVerificationId output>` |

   The TXT record proves to Azure that the domain is yours. An apex domain
   (`example.org` itself) cannot have a CNAME. Use an A record to the app's
   IP address instead (in the portal under **Custom domains**), plus the
   TXT record at `asuid`.

2. **Wait for DNS**: `dig +short time.example.org` should show the
   azurewebsites name.

3. **Set `customDomain = 'time.example.org'`** in the parameter file and re-run
   step 2 of Part 2. The template binds the domain, issues a free managed
   certificate, binds it, and changes `APP_URL`, `AUTH_URL` and the
   availability tests to the new address.

4. **Update the redirect URIs**. Microsoft and Google check them exactly,
   including `https` and the path:

   | Provider | Redirect URI |
   |---|---|
   | Microsoft (Entra) | `https://time.example.org/api/auth/callback/microsoft-entra-id` |
   | Microsoft directory consent | `https://time.example.org/api/directory/microsoft/callback` |
   | Microsoft front-channel logout | `https://time.example.org/api/auth/signout` |
   | Google | `https://time.example.org/api/auth/callback/google` |

   Add the new URIs before removing the old ones, and sign-in keeps working
   throughout.

5. **Update `APP_BASE_URL`** in GitHub to `https://time.example.org`.

The azurewebsites.net address keeps answering, but sign-in and every emailed
link use the custom domain. The managed certificate renews itself.

---

## What the template does not do, on purpose

- **No private network.** Postgres has a public endpoint that requires TLS
  and admits only the app's outbound addresses. The deploy workflow opens it
  to its own runner for the length of a migration. A virtual network with a
  private endpoint is more isolated, but it costs more, and migrations would
  then need a self-hosted runner inside it. See "The database has a public
  endpoint behind a firewall" in `docs/DECISIONS.md`.
- **The app connects as the database administrator.** A separate
  least-privilege role is a sensible hardening step, done in SQL after the
  first deploy. The template cannot create database roles.
- **It never touches the secrets in step 3.** A redeploy cannot rotate them.
