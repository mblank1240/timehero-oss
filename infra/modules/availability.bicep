// An availability test on one URL, and the alert that fires when it fails
// from two or more locations at once — one location failing is usually the
// test's own network, not the site.

param name string
param location string
param insightsId string
param url string
param frequencySeconds int
param description string
param actionGroupId string

var locations = [
  'us-va-ash-azr' // East US
  'us-il-ch1-azr' // North Central US
  'us-tx-sn1-azr' // South Central US
  'us-ca-sjc-azr' // West US
]

resource test 'Microsoft.Insights/webtests@2022-06-15' = {
  name: name
  location: location
  kind: 'standard'
  tags: {
    // Ties the test to its Application Insights resource in the portal.
    'hidden-link:${insightsId}': 'Resource'
  }
  properties: {
    SyntheticMonitorId: name
    Name: name
    Description: description
    Enabled: true
    Frequency: frequencySeconds
    Timeout: 30
    Kind: 'standard'
    RetryEnabled: true
    Locations: [for loc in locations: { Id: loc }]
    Request: {
      RequestUrl: url
      HttpVerb: 'GET'
      ParseDependentRequests: false
    }
    ValidationRules: {
      ExpectedHttpStatusCode: 200
      SSLCheck: true
      SSLCertRemainingLifetimeCheck: 7
    }
  }
}

resource alert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${name}-alert'
  location: 'global'
  properties: {
    description: description
    severity: 1
    enabled: true
    scopes: [test.id, insightsId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.WebtestLocationAvailabilityCriteria'
      webTestId: test.id
      componentId: insightsId
      failedLocationCount: 2
    }
    actions: [{ actionGroupId: actionGroupId }]
  }
}
