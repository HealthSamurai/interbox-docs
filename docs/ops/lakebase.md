# Databricks Lakebase

Interbox can keep its database on a Databricks Lakebase Autoscaling project,
including one it shares with Aidbox. Lakebase authenticates Databricks
identities with OAuth tokens that live one hour and are checked only when a
connection logs in, so a token pasted into `DATABASE_URL` stops working for
every connection opened after the first hour. Interbox logs in as a
**service principal** and fetches its own tokens.

A native Postgres role with a password on the Lakebase project needs no setup
from this page: a plain `DATABASE_URL` with that password works as it does on
any managed Postgres.

Databricks has moved every Lakebase Provisioned instance onto the Autoscaling
platform, so Interbox supports Autoscaling projects only.

## Settings

| variable | value |
|---|---|
| `INTERBOX_DB_AUTH_METHOD` | `databricks-autoscale`. Unset, blank or `password` keeps the password in `DATABASE_URL` |
| `INTERBOX_DB_DATABRICKS_HOST` | the workspace address, `https://<workspace>.cloud.databricks.com`, or the bare host |
| `INTERBOX_DB_DATABRICKS_CLIENT_ID` | the service principal's application ID |
| `INTERBOX_DB_DATABRICKS_CLIENT_SECRET` | an OAuth secret of that service principal, with the `postgres` scope |
| `INTERBOX_DB_DATABRICKS_ENDPOINT` | the endpoint, `projects/<project>/branches/<branch>/endpoints/<endpoint>` (`databricks postgres list-endpoints` prints it) |
| `DATABASE_URL` | `postgres://<application-id>@ep-<name>.database.<region>.cloud.databricks.com/interbox?sslmode=verify-full`, with **no password** |

Lakebase serves certificates that verify, so use `sslmode=verify-full`. Today
node-postgres treats `require` the same way but logs a warning for it, and its
next major version will stop verifying the server under `require`.

Interbox refuses to start when a variable is missing, when the host is not an
`https://` address, and when `DATABASE_URL` still carries a password: under
`databricks-autoscale` that password would be replaced without a word.

Keep the client secret in a Kubernetes Secret like the other credentials. The
dashboard assistant never receives it.

## Preparing the Lakebase project

- **Connect to the endpoint's own host**, not its `-pooler` host. The pooler is
  PgBouncer in transaction mode, which breaks the `LISTEN`, advisory locks and
  prepared statements the engine relies on.
- **Turn scale-to-zero off** for the endpoint. Suspending the compute drops every
  connection, every `LISTEN` and every advisory lock, and empties the engine's
  `UNLOGGED` tables.
- **Give the service principal the Workspace access entitlement and nothing
  more**, and create its OAuth secret with the `postgres` scope only. Interbox
  asks for a `postgres`-scoped token, which is all the credential call needs. An
  `all-apis` secret works too, but a leak of it reaches every API.
- **Create a Postgres role for the service principal** and grant it the
  database, from the project's SQL editor as the project owner (see
  [Lakebase authentication](https://docs.databricks.com/aws/en/oltp/projects/authentication)):

  ```sql
  CREATE EXTENSION IF NOT EXISTS databricks_auth;
  SELECT databricks_create_role('<application-id>', 'SERVICE_PRINCIPAL');
  GRANT CONNECT, CREATE, TEMPORARY ON DATABASE interbox TO "<application-id>";
  ```

- **Create the database** before the first start, as the project owner. Interbox
  connects to the database in `DATABASE_URL` first and uses it as it is when it
  exists. To let Interbox create it instead, give the role `CREATEDB`; it creates
  the database from the project's `postgres` database.
- **Tune with the role or the database.** Lakebase does not take server
  parameters, so the session settings from [PostgreSQL tuning per tier](sizing.md#postgresql-tuning-per-tier)
  go on the role instead, and Lakebase sizes the server-level ones itself. Facet
  `work_mem` is set per query by `FACET_WORK_MEM` either way.

  ```sql
  ALTER ROLE "<application-id>" SET maintenance_work_mem = '512MB';
  ALTER ROLE "<application-id>" SET effective_cache_size = '3GB';
  ```

The `pg_trgm` and `btree_gist` extensions the engine installs are available on
Lakebase, and nothing Interbox runs needs a superuser.

## How tokens are used

When a connection logs in and Interbox has no current token, it exchanges the
client secret for a workspace token, asks Lakebase for a database credential for
the endpoint, and keeps that credential until five minutes before it expires.
Connections opened in the meantime reuse it. Expect a few fetches an hour, each
logged as `fetched a Lakebase database credential` with the endpoint and the
expiry, never the token.

A connection stays open after its token expires: Lakebase checks the token only
at login. Lakebase does close connections older than three days, and idle ones
after 24 hours. The engine opens new ones as it needs them.

When Databricks refuses a fetch in those last five minutes, Interbox logs in with
the token it has and asks again on the next connection. Once the token has
expired, the connection fails instead, and the log carries Databricks' answer:
`could not fetch a Lakebase database credential`, with the status and body as
its cause. When Postgres refuses a token at login, Interbox drops it, and the
next connection fetches a new one.

## Workspace code

A workspace action or admin script that opens its own connection should build it
with `postgresConfig()`, so it logs in the same way the engine does. It returns
a `pg` config, so the workspace needs `pg`, and `@types/pg` for type checking:

```ts
import { Client } from "pg";
import { forgetRefusedCredential, postgresConfig } from "@health-samurai/interbox/postgres";

const client = new Client(postgresConfig());
await client.connect().catch((err: unknown) => {
  forgetRefusedCredential(err);
  throw err;
});
```

`forgetRefusedCredential()` drops the cached token when the error is Postgres
refusing the login, so the next connection fetches a new one. Any other error
leaves it alone.
