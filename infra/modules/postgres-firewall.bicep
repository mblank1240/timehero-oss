// One firewall rule per outbound address of the web app. A module so the
// address list, which exists only once the app does, can size the loop.

param serverName string
param addresses array

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' existing = {
  name: serverName
}

@batchSize(1)
resource rules 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = [
  for (ip, i) in addresses: {
    parent: server
    name: 'app-outbound-${i}'
    properties: {
      startIpAddress: trim(ip)
      endIpAddress: trim(ip)
    }
  }
]
