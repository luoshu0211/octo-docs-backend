# Redis connection configuration

The shared command client, Hocuspocus publisher/subscriber and application event
subscriber use the same connection configuration. No database migration is needed.

## Configuration

Prefer a URL injected by the deployment's Secret/environment configuration:

```dotenv
# Password authentication (Redis default user)
REDIS_URL=redis://:example-password@redis.internal:6379/0
REDIS_PREFIX=octo-docs
```

```dotenv
# Redis 6+ ACL and TLS
REDIS_URL=rediss://docs-user:example-password@redis.internal:6379/0
REDIS_PREFIX=octo-docs
```

Alternatively, leave `REDIS_URL` empty or unset and use individual fields:

```dotenv
REDIS_HOST=redis.internal
REDIS_PORT=6379
REDIS_USERNAME=docs-user
REDIS_PASSWORD=example-password
REDIS_DB=0
REDIS_TLS=true
REDIS_PREFIX=octo-docs
```

Existing unauthenticated host/port configuration continues to work. Defaults are
`127.0.0.1`, port `6379`, DB `0`, no credentials, no TLS, prefix `octo-docs`.
`REDIS_TLS` accepts `true/false/1/0` (case-insensitive). Ports must be decimal
integers in `1..65535`; DB must be a non-negative safe integer and must exist on
the Redis server. A username requires a non-empty password. Empty username and
password mean no authentication; password whitespace is preserved.

A non-empty `REDIS_URL` owns **all** connection fields: host, port, username,
password, DB and TLS. No field is filled from `REDIS_HOST`, `REDIS_PASSWORD`, etc.
For example, a URL without credentials ignores a separate `REDIS_PASSWORD`.
`REDIS_PREFIX` always applies independently. Invalid URLs fail configuration
loading; they never fall back to field configuration. Whitespace-only URLs fail.

URL schemes are `redis://` and `rediss://`. Missing port/DB mean `6379`/`0`.
IPv6 URLs require brackets, e.g. `redis://:example-password@[::1]:6379/0`.
Queries, fragments, additional path segments and raw whitespace/control characters
are rejected. Unix sockets, Sentinel, Cluster and passwordless named ACL users
are not supported by this configuration contract.

Percent-encode username and password components exactly once: password
`p@ss:/#%` becomes `p%40ss%3A%2F%23%25`. Field-mode `REDIS_PASSWORD` takes the raw
password without decoding. Never commit real credentials or print the environment.

## TLS and namespaces

`rediss://` and `REDIS_TLS=true` enable certificate validation and DNS SNI.
IP addresses require a matching certificate IP SAN. There is no insecure TLS
toggle or mTLS configuration. To trust a private CA, mount its certificate and
set `NODE_EXTRA_CA_CERTS` before starting Node; do not disable certificate checks.

Redis DB numbers isolate keys, **not Pub/Sub messages**. Use a distinct
`REDIS_PREFIX` or Redis instance for each environment. Every replica in one
deployment must use the same endpoint, DB and prefix. The prefix is applied by
existing key/channel builders, not ioredis `keyPrefix`.

## Startup, permissions and reconnect

Before opening HTTP or WebSocket listeners, startup waits at most 10 seconds for
all four Redis connections, explicit credential verification and event
subscriptions. Transient TCP, DNS and socket failures are retried by ioredis
within that shared deadline. Redis setup-command failures (such as a rejected
`SELECT`), AUTH/ACL errors and TLS errors fail immediately with nonzero exit
status, and any startup failure closes the newly created connections. Explicit
verification also rejects a supplied password against a server with no password
configured (ioredis otherwise allows this as a compatibility fallback). Errors
use fixed categories and omit URL, credentials and AUTH command arguments.

The timeout covers Redis initialization, not earlier MySQL checks or the whole
process bootstrap. Successful startup does not prove that every business command
is allowed. `/healthz` remains a liveness endpoint, not a Redis readiness monitor.
Normal command retries and runtime reconnect/resubscribe behavior are unchanged.
Configuration is read once at startup; restart replicas to rotate credentials.

The implementation uses Hocuspocus's public `createClient` option to create two
independent clients from the same parsed options. This avoids the bundled older
ioredis constructor interpreting an IPv6 host as a URL or Unix socket path.
Hocuspocus retains ownership of both connections. Its Redlock DB setting is also
initialized before use: the lock scripts otherwise select DB 0 independently of
the connection's configured DB. Neither adjustment changes dependency versions.

ACL policies must allow the service's key **and channel** namespaces. Besides
read/write and `PUBLISH`/`SUBSCRIBE`/`UNSUBSCRIBE`, account for connection setup
(`AUTH`, `INFO`, `SELECT`, `PING` and supported `CLIENT` setup commands),
`PUBSUB NUMSUB`, and Lua/script commands used by locks and atomic operations.
Validate the actual policy with collaboration and event flows; AUTH success alone
does not establish sufficient permissions. Do not grant production accounts
administrative commands merely because integration tests use a dedicated account.

## Verification

Offline tests:

```sh
npx vitest run test/redisConfig.test.ts test/redisConnections.test.ts
npm run typecheck
npm run lint
npm run build
```

Dedicated integration tests require `redis-server` with TLS support, OpenSSL,
and permission to bind loopback ports:

```sh
REDIS_AUTH_INTEGRATION=1 npx vitest run test/redisAuth.integration.test.ts
```

They create temporary Redis processes, credentials and certificates; they never
connect to an existing Redis service. All processes and temporary files are
cleaned up. Tests cover no auth, password auth, ACL, raw and encoded passwords,
DB selection, locks, namespace restrictions, reconnect, IPv6, verified TLS and two
Hocuspocus instances. The Hocuspocus persistence fixture is in memory; production
MySQL persistence and full application/browser flows remain separate acceptance
checks. Missing prerequisites fail explicitly when the integration suite is enabled.

## Rollout and rollback

1. Deploy the compatible backend to all replicas before requiring authentication
   on an existing anonymous Redis instance.
2. Inject the new URL or individual fields. Deploy-managed `env_file` setups need
   only an environment update; templates with explicit allowlists must pass the new
   variables. Recreate/restart the backend with the intended immutable image.
3. Verify all connections, cross-replica document updates, permission invalidations,
   comments and enabled PPT room events. Keep DB and prefix unchanged.
4. Redis 6+ ACL allows an overlapping account transition: move all replicas to the
   new identity before disabling the old anonymous access. `requirepass` changes
   without an overlap require a coordinated maintenance window.

Once Redis requires authentication, the old backend cannot connect. Roll back to a
version that supports these fields, or separately coordinate Redis access policy.
Rolling back only an image is insufficient. Changing DB or prefix is a separate
namespace migration, not part of credential rollout.
