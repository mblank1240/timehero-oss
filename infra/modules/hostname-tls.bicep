// The custom domain's binding again, now with its certificate. A module
// because one template cannot declare the same binding twice.

param appName string
param hostname string
param thumbprint string

resource app 'Microsoft.Web/sites@2023-12-01' existing = {
  name: appName
}

resource binding 'Microsoft.Web/sites/hostNameBindings@2023-12-01' = {
  parent: app
  name: hostname
  properties: {
    siteName: appName
    hostNameType: 'Verified'
    sslState: 'SniEnabled'
    thumbprint: thumbprint
  }
}
