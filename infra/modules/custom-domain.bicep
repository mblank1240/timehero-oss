// A custom domain with a free App Service managed certificate.
//
// Three steps, because each needs the one before: bind the hostname without
// TLS (Azure checks the DNS records here), issue the certificate for it, then
// bind again with the certificate. The DNS records — a CNAME to the app's
// default hostname and an `asuid.<host>` TXT holding the verification id —
// must exist before this runs; docs/AZURE-SETUP.md has them.

param appName string
param planId string
param location string
param hostname string

resource app 'Microsoft.Web/sites@2023-12-01' existing = {
  name: appName
}

resource binding 'Microsoft.Web/sites/hostNameBindings@2023-12-01' = {
  parent: app
  name: hostname
  properties: {
    siteName: appName
    hostNameType: 'Verified'
    sslState: 'Disabled'
  }
}

resource certificate 'Microsoft.Web/certificates@2023-12-01' = {
  name: '${appName}-${replace(hostname, '.', '-')}'
  location: location
  dependsOn: [binding]
  properties: {
    serverFarmId: planId
    canonicalName: hostname
  }
}

module secure 'hostname-tls.bicep' = {
  name: 'custom-domain-tls'
  params: {
    appName: appName
    hostname: hostname
    thumbprint: certificate.properties.thumbprint
  }
}
