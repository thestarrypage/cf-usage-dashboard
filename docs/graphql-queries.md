# Cloudflare GraphQL Analytics queries used by the dashboard

Reference queries for everything the dashboard reports, runnable in the [GraphQL API explorer](https://graphql.cloudflare.com/explorer) or with `curl`. The examples use September 2026; change the dates to suit.

Endpoint: `POST https://api.cloudflare.com/client/v4/graphql`
Headers: `Authorization: Bearer $CLOUDFLARE_API_TOKEN`, `Content-Type: application/json`
Body: `{"query": "<query>", "variables": { ... }}`

Account: `accountTag = <ACCOUNT_ID>` (your account ID, from the dashboard URL or `wrangler whoami`)

All queries use **2026-09-01 → 2026-09-30** (UTC) unless noted. Retention limits seen in testing:

| Dataset | Limit | Effect on a Sep 1–30 query |
|---|---|---|
| `imagesTransformationsAdaptiveGroups`, `imagesRequestsAdaptiveGroups` | ~31 days | Rejected (earliest ~Sep 14) |
| `aiInferenceAdaptiveGroups` | ~32 days | Rejected (earliest ~Sep 14) |
| `httpRequestsAdaptiveGroups`, `dnsAnalyticsAdaptiveGroups` | ~31 days on **Free** zones | Rejected for Free zones; Enterprise zones OK |
| `aegisIpUtilizationAdaptiveGroups` | 1 day retention, 1 day max range | Only the last 24h can be queried |

Zones: use each zone's ID (`zoneTag`) from the zone's Overview page or `GET /zones?account.id=<ACCOUNT_ID>`.

---

## 1. Workers invocations by script

```graphql
query ($a: String!, $s: Time!, $u: Time!) {
  viewer {
    accounts(filter: { accountTag: $a }) {
      workersInvocationsAdaptive(
        limit: 10
        filter: { datetime_geq: $s, datetime_leq: $u }
        orderBy: [sum_requests_DESC]
      ) {
        sum { requests errors }
        dimensions { scriptName }
      }
    }
  }
}
```

Variables:

```json
{ "a": "<ACCOUNT_ID>", "s": "2026-09-01T00:00:00Z", "u": "2026-09-30T23:59:59Z" }
```

> First attempt `{ viewer { zones(limit: 50) { zoneTag } } }` failed with `too many zones requested` — always filter zones by `zoneTag`.

---

## 2. CDN requests & data transfer per zone

Run once per zoneTag. No dimensions → one aggregated row for the whole range.

```graphql
query ($z: String!, $s: Date!, $u: Date!) {
  viewer {
    zones(filter: { zoneTag: $z }) {
      httpRequests1dGroups(limit: 100, filter: { date_geq: $s, date_leq: $u }) {
        sum { requests bytes cachedRequests cachedBytes }
      }
    }
  }
}
```

Variables:

```json
{ "z": "<ZONE_ID>", "s": "2026-09-01", "u": "2026-09-30" }
```

---

## 3. Unique image transformations

```graphql
query ($a: String!) {
  viewer {
    accounts(filter: { accountTag: $a }) {
      daily: imagesUniqueTransformations(
        limit: 100
        filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }
        orderBy: [date_ASC]
      ) { date transformations }

      acc: imagesUniqueTransformationsAccumulatedSinceStartOfMonth(
        limit: 100
        filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }
        orderBy: [date_ASC]
      ) { date transformations }
    }
  }
}
```

Cross-check — raw transformation events and image requests. ⚠️ These two datasets only keep ~31 days. Run on Oct 16 with a Sep 1 start, Cloudflare rejects them (`cannot request data older than 4w3d`); move `date_geq` forward to the earliest day still kept:

```graphql
query ($a: String!) {
  viewer {
    accounts(filter: { accountTag: $a }) {
      tr: imagesTransformationsAdaptiveGroups(
        limit: 10
        filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }
      ) { count }

      rq: imagesRequestsAdaptiveGroups(
        limit: 10
        filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }
      ) { sum { requests } }
    }
  }
}
```

> Limits hit: max range ~8w5d per query; adaptive image datasets can't go back further than ~4w3d.

---

## 4. Spectrum — data transfer / IPv4 destinations

```graphql
query ($a: String!, $s: Time!, $u: Time!) {
  viewer {
    accounts(filter: { accountTag: $a }) {
      tot: spectrumNetworkAnalyticsAdaptiveGroups(
        limit: 10
        filter: { datetime_geq: $s, datetime_leq: $u }
      ) {
        sum { bits packets }
        dimensions { direction ethertype }
      }

      ips: spectrumNetworkAnalyticsAdaptiveGroups(
        limit: 200
        filter: { datetime_geq: $s, datetime_leq: $u, ethertype: 2048 }
      ) {
        sum { bits }
        dimensions { ipDestinationAddress direction applicationTag }
      }
    }
  }
}
```

Variables:

```json
{ "a": "<ACCOUNT_ID>", "s": "2026-09-01T00:00:00Z", "u": "2026-09-30T23:59:59Z" }
```

> `ethertype: 2048` = IPv4. Connection counts are not in GraphQL — they came from the REST endpoints
> `GET /zones/{zone_id}/spectrum/analytics/events/summary?metrics=count,bytesIngress,bytesEgress,durationAvg&since=2026-09-01T00:00:00Z&until=2026-09-30T23:59:59Z`
> and `GET /zones/{zone_id}/spectrum/analytics/aggregate/current`.

---

## 5. Good requests per zone

### 5a. Exact counts for every zone — `threats` (used for the September report)

Run once per zoneTag. Good = `requests − threats`. Works for the full month on every plan (Free zones included).

```graphql
query ($z: String!, $s: Date!, $u: Date!) {
  viewer {
    zones(filter: { zoneTag: $z }) {
      httpRequests1dGroups(limit: 100, filter: { date_geq: $s, date_leq: $u }) {
        sum { requests threats }
      }
    }
  }
}
```

Variables:

```json
{ "z": "<ZONE_ID>", "s": "2026-09-01", "u": "2026-09-30" }
```

### 5b. Breakdown by security action (sampled)

Good = everything except `block`, `managed_challenge` and `link_maze_visited`.
⚠️ Free-plan zones keep this data only ~31 days, so a Sep 1 start is rejected for them; Enterprise zones work for the full month.

```graphql
query ($z: String!, $s: Date!, $u: Date!) {
  viewer {
    zones(filter: { zoneTag: $z }) {
      httpRequestsAdaptiveGroups(
        limit: 200
        filter: { date_geq: $s, date_leq: $u, requestSource: "eyeball" }
      ) {
        count
        dimensions { securityAction securitySource }
      }
    }
  }
}
```

Variables:

```json
{ "z": "<ZONE_ID>", "s": "2026-09-01", "u": "2026-09-30" }
```

---

## 6. Developer platform usage

Each block was sent as its own query, wrapped like this:

```graphql
query ($a: String!) {
  viewer {
    accounts(filter: { accountTag: $a }) {
      x: <BLOCK>
    }
  }
}
```

Common filter used below: `filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }`

### D1

```graphql
d1AnalyticsAdaptiveGroups(limit: 100, filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }) {
  sum { readQueries writeQueries rowsRead rowsWritten }
  dimensions { databaseId }
}
```

```graphql
d1StorageAdaptiveGroups(limit: 100, filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }) {
  max { databaseSizeBytes }
  dimensions { databaseId }
}
```

```graphql
d1StorageAdaptiveGroups(limit: 100, filter: { date: "2026-09-30" }) {
  max { databaseSizeBytes }
  dimensions { databaseId }
}
```

### Durable Objects

```graphql
durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }) {
  sum { requests errors wallTime }
  dimensions { scriptName }
}
```

```graphql
durableObjectsPeriodicGroups(limit: 100, filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }) {
  sum {
    activeTime cpuTime duration rowsRead rowsWritten
    storageReadUnits storageWriteUnits storageDeletes
    inboundWebsocketMsgCount outboundWebsocketMsgCount
  }
  max { activeWebsocketConnections }
  dimensions { namespaceId }
}
```

```graphql
durableObjectsStorageGroups(limit: 100, filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }) {
  max { storedBytes }
}
```

```graphql
durableObjectsSqlStorageGroups(limit: 100, filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }) {
  max { storedBytes }
  dimensions { namespaceId }
}
```

### KV

```graphql
kvOperationsAdaptiveGroups(limit: 100, filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }) {
  sum { requests objectBytes }
  dimensions { actionType }
}
```

```graphql
kvStorageAdaptiveGroups(limit: 100, filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }) {
  max { byteCount keyCount }
  dimensions { namespaceId }
}
```

### R2

```graphql
r2OperationsAdaptiveGroups(limit: 200, filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }) {
  sum { requests }
  dimensions { actionType }
}
```

```graphql
r2StorageAdaptiveGroups(limit: 100, filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }) {
  max { payloadSize metadataSize objectCount }
  dimensions { bucketName storageClass }
}
```

```graphql
r2BandwidthUsageAdaptiveGroups(limit: 100, filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }) {
  sum { bytesDownload bytesUpload }
}
```

### Workers

```graphql
workersInvocationsAdaptive(limit: 10, filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }) {
  sum { requests errors subrequests cpuTimeUs }
}
```

```graphql
workersInvocationsAdaptive(
  limit: 15
  filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }
  orderBy: [sum_requests_DESC]
) {
  sum { requests errors cpuTimeUs }
  dimensions { scriptName }
}
```

### Workers AI

⚠️ Workers AI data is only kept ~32 days — a Sep 1 start is rejected once today is past ~Oct 3.

```graphql
query ($a: String!) {
  viewer {
    accounts(filter: { accountTag: $a }) {
      m: aiInferenceAdaptiveGroups(
        limit: 100
        filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }
        orderBy: [sum_totalNeurons_DESC]
      ) {
        count
        sum { totalNeurons totalInputTokens totalOutputTokens }
        dimensions { modelId }
      }

      d: aiInferenceAdaptiveGroups(
        limit: 100
        filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }
        orderBy: [date_ASC]
      ) {
        count
        sum { totalNeurons }
        dimensions { date }
      }
    }
  }
}
```

---

## 7. Aegis IP utilization

⚠️ Beta dataset. **1-day retention and 1-day maximum range** — September cannot be queried; only the last 24 hours. Returns no rows when Aegis is not enabled or carries no traffic.

```graphql
query ($a: String!, $s: Time!, $u: Time!) {
  viewer {
    accounts(filter: { accountTag: $a }) {
      tot: aegisIpUtilizationAdaptiveGroups(
        limit: 1
        filter: { datetime_geq: $s, datetime_leq: $u }
      ) {
        avg { utilization }
        max { utilization }
      }

      key: aegisIpUtilizationAdaptiveGroups(
        limit: 500
        filter: { datetime_geq: $s, datetime_leq: $u }
        orderBy: [max_utilization_DESC]
      ) {
        avg { utilization }
        max { utilization }
        dimensions { popUtilizationKey }
      }

      hr: aegisIpUtilizationAdaptiveGroups(
        limit: 100
        filter: { datetime_geq: $s, datetime_leq: $u }
        orderBy: [datetimeHour_ASC]
      ) {
        avg { utilization }
        max { utilization }
        dimensions { datetimeHour }
      }
    }
  }
}
```

Variables (last 24h at the time of running):

```json
{ "a": "<ACCOUNT_ID>", "s": "2026-10-15T09:05:22Z", "u": "2026-10-16T09:00:22Z" }
```

Other filters available: `egressIp`, `origin`, `popName`, `popUtilizationKey`.
`utilization` is a percentage; `max` is the highest in a single data center.

> Aegis configuration (enabled / pool ID) is REST, not GraphQL: `GET /zones/{zone_id}/settings/aegis`
> (needs **Zone → Zone Settings: Read**). Static IP / BYOIP: `GET /accounts/{account_id}/addressing/address_maps`,
> `/addressing/prefixes`, `/addressing/leases` (needs **Account → IP Prefixes: Read**). All returned 403 with the current token.

---

## 8. DNS queries per zone

Run once per zoneTag. Counts are sampled estimates (rounded to 100).
⚠️ Free-plan zones keep this data only ~31 days, so a Sep 1 start is rejected for them; Enterprise zones work for the full month.

```graphql
query ($z: String!) {
  viewer {
    zones(filter: { zoneTag: $z }) {
      t: dnsAnalyticsAdaptiveGroups(
        limit: 1
        filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }
      ) { count }

      rc: dnsAnalyticsAdaptiveGroups(
        limit: 20
        filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { responseCode }
      }
    }
  }
}
```

Top query names:

```graphql
query ($z: String!) {
  viewer {
    zones(filter: { zoneTag: $z }) {
      dnsAnalyticsAdaptiveGroups(
        limit: 15
        filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { queryName }
      }
    }
  }
}
```

By day:

```graphql
query ($z: String!) {
  viewer {
    zones(filter: { zoneTag: $z }) {
      dnsAnalyticsAdaptiveGroups(
        limit: 40
        filter: { date_geq: "2026-09-01", date_leq: "2026-09-30" }
        orderBy: [date_ASC]
      ) {
        count
        dimensions { date }
      }
    }
  }
}
```

Other dimensions available: `coloName`, `destinationIP`, `ipVersion`, `protocol`, `querySizeBucket`, `queryType`,
`responseCached`, `responseSizeBucket`, `responseStale`, `sourceIP`, `upstreamIP`.

> The September report used the REST API as the primary source, because it covers every zone for the full month:
> `GET /zones/{zone_id}/dns_analytics/report?metrics=queryCount&since=…&until=…`
> summed per day for Enterprise zones and per 6-hour window for Free zones (Free plan max range is 6h).
> partial.example has no DNS analytics (CNAME / partial setup).
> GraphQL (sampled) and the REST report can differ noticeably for some zones; compare both if the number matters for billing.

---

## 9. Zero Trust (Cloudflare One)

The `cf1…` rollups filter on `datetime` (a Time), not `date`. The `1d` rollups allow a 90-day window
and keep 365 days; `1h` rollups allow 31 days and keep 62; `Raw` allows 3 hours.

```graphql
query ($a: String!, $s: Time!, $u: Time!) {
  viewer {
    accounts(filter: { accountTag: $a }) {
      access: cf1AccessLogins1dGroups(limit: 100, filter: { datetime_geq: $s, datetime_lt: $u }, orderBy: [sum_logins_DESC]) {
        sum { logins }
        uniq { users }
        dimensions { appName }
      }
      dns: cf1GatewayDns1dGroups(limit: 1, filter: { datetime_geq: $s, datetime_lt: $u }) {
        sum { queries queryBytes responseBytes }
        uniq { users devices }
      }
      http: cf1GatewayHttp1dGroups(limit: 1, filter: { datetime_geq: $s, datetime_lt: $u }) {
        sum { requests bodyBytesSent bodyBytesRcvd dlpMatchedRequestsTotal avBlockedFiles isolatedRequests }
        uniq { users applications }
      }
      network: cf1GatewayNetwork1dGroups(limit: 1, filter: { datetime_geq: $s, datetime_lt: $u }) {
        sum { requests }
        uniq { sessions users devices }
      }
      sessions: cf1GatewayNetworkSession1dGroups(limit: 1, filter: { datetime_geq: $s, datetime_lt: $u }) {
        sum { sessions bytesTotal bytesUpload bytesDownload }
        avg { tcpHandshakeMs }
      }
      warp: warpDeviceAdaptiveGroups(limit: 20, filter: { datetime_geq: $s, datetime_lt: $u }, orderBy: [count_DESC]) {
        count
        uniq { deviceIds }
        dimensions { clientPlatform }
      }
      tunnel: cloudflareTunnelsAnalyticsAdaptiveGroups(limit: 1, filter: { datetime_geq: $s, datetime_lt: $u }) {
        sum { bits egressBits }
      }
    }
  }
}
```

Variables:

```json
{ "a": "<ACCOUNT_ID>", "s": "2026-09-01T00:00:00Z", "u": "2026-10-01T00:00:00Z" }
```

> Limits seen: `accessLoginRequestsAdaptiveGroups` allows 1 week per query; long `cf1AccessLogins1dGroups`
> ranges can fail with "would read too much data" (split the range); `zeroTrustPrivateNetworkDiscoveryGroups`
> and `privacyProxy*` filter on `date`. Gateway DNS `resolverDecision` codes are listed in the
> [Gateway logs docs](https://developers.cloudflare.com/cloudflare-one/insights/logs/dashboard-logs/gateway-logs/#resolver-decisions).

---

## Appendix — schema introspection used to discover datasets

List datasets on account / zone:

```graphql
{ __type(name: "account") { fields { name } } }
```

```graphql
{ __type(name: "zone") { fields { name } } }
```

Inspect a dataset's fields (swap the type name, e.g. `AccountSpectrumNetworkAnalyticsAdaptiveGroupsDimensions`, `ZoneHttpRequestsAdaptiveGroupsDimensions`, `AccountImagesRequestsAdaptiveGroupsSum`):

```graphql
{ __type(name: "AccountImagesUniqueTransformations") { fields { name } inputFields { name } } }
```
