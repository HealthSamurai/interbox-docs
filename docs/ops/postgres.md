# PostgreSQL Backups

Interbox keeps everything it must remember in its PostgreSQL database: what it
received, what it delivered, and where each feed stopped reading. A backup with
point-in-time recovery lets you bring a deployment back to a moment before a
lost disk, a bad migration or a mistaken delete. This page says what the
database holds, how to back it up on a managed service or on Kubernetes, and
how to restore.

## What the database holds

- **Units.** Every input a pipeline stored, with the value its store keeps.
  The store has no retention, so the database is the only copy of a message
  that arrived over MLLP or a webhook: Interbox answered the sending system
  once the unit was stored.
- **Pipeline state.** The cursors and markers your steps keep, and the
  fingerprints the Aidbox sender records for each resource it delivered. See
  [Units and State](../concepts/units-and-state.md#pipeline-state).
- **What each file-drop feed has read.** Interbox records every delivery and
  file it read. See [Reading Files from Storage](../concepts/reading-files/README.md).
- **The workspace builds**, the active lease and the pipelines you paused.

## What losing it costs

An Interbox started on an empty database starts over:

- **Every file-drop feed reads its storage again**, from the first delivery
  (or after `startAfter`, when the pipeline sets one), and delivers each record
  again. Aidbox receives the old deliveries before the new ones, so it serves
  stale data until the feed catches up.
- **The Aidbox sender sends every resource again.** Its fingerprints are gone,
  so `skipUnchanged()` has nothing to compare with.
- **Units received over MLLP and webhooks are gone** unless the sending system
  sends them again.

Back up every production database. A staging database that you can rebuild
from its sources is your call.

## Managed PostgreSQL

Managed services back up the whole server, and point-in-time recovery comes
with it once you turn it on:

| service | what to turn on |
|---|---|
| Google Cloud SQL | automated backups and point-in-time recovery |
| Amazon RDS | a backup retention period of at least one day, which also enables point-in-time recovery |
| Azure Database for PostgreSQL flexible server | nothing: backups are always on. Choose the retention period, 7 to 35 days |

When Interbox has its own database on the server that Aidbox uses, the
server's backups cover both.

## PostgreSQL on Kubernetes

On Kubernetes, run PostgreSQL with the [CloudNativePG](https://cloudnative-pg.io)
operator and its [Barman Cloud plugin](https://cloudnative-pg.io/plugin-barman-cloud/).
The plugin archives every WAL file to object storage as PostgreSQL writes it,
and takes a base backup on a schedule. Together they let you restore to any
moment in the retention window. The operator's own `barmanObjectStore`
setting is deprecated and CloudNativePG 1.32 removes it, so use the plugin.

You need:

- the CloudNativePG operator and the Barman Cloud plugin, installed in the
  cluster
- a bucket for the backups, in Google Cloud Storage, Amazon S3 or Azure Blob
  Storage
- write access to that bucket for the cluster's Kubernetes service account,
  which CloudNativePG names after the cluster

{% stepper %}
{% step %}
### Describe the bucket

An `ObjectStore` names the bucket and how long to keep backups. This one
writes to Google Cloud Storage with the pod's Workload Identity. The plugin's
documentation shows the settings for Amazon S3 and Azure.

```yaml
apiVersion: barmancloud.cnpg.io/v1
kind: ObjectStore
metadata:
  name: interbox-backups
spec:
  configuration:
    data:
      compression: lz4
    destinationPath: gs://interbox-backups-example/interbox
    googleCredentials:
      gkeEnvironment: true
    wal:
      compression: lz4
  retentionPolicy: 30d
```

When the bucket has a retention lock, set `retentionPolicy` no shorter than
the lock: the plugin cannot delete a backup the lock still holds.
{% endstep %}

{% step %}
### Create the cluster

The cluster names the `ObjectStore` as its WAL archiver:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: interbox-postgres
spec:
  bootstrap:
    initdb:
      database: interbox
      owner: interbox
  instances: 2
  plugins:
    - isWALArchiver: true
      name: barman-cloud.cloudnative-pg.io
      parameters:
        barmanObjectName: interbox-backups
  storage:
    size: 50Gi
```

CloudNativePG keeps the connection string for the `interbox` user in the
Secret `interbox-postgres-app`, under `uri`. Use it as `DATABASE_URL`, with
the TLS settings from [TLS to PostgreSQL](deploy.md#tls-to-postgresql): the
operator signs the server's certificate with its own CA, which it keeps in the
Secret `interbox-postgres-ca`. Interbox creates the extensions it needs, since
`pg_trgm` and `btree_gist` are trusted extensions the database owner may
create.
{% endstep %}

{% step %}
### Schedule the base backup

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: interbox-postgres
spec:
  backupOwnerReference: cluster
  cluster:
    name: interbox-postgres
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
  schedule: 0 0 1 * * *
```

The schedule has six fields, seconds first: this one runs at 01:00 every day.
Set `immediate: true` to take the first backup as soon as you apply it.
{% endstep %}

{% step %}
### Check it

The cluster's `ContinuousArchiving` condition turns `True` once the first WAL
file reaches the bucket, and `kubectl get backup` lists each base backup with
its phase:

```console
kubectl get cluster interbox-postgres -o jsonpath='{.status.conditions[?(@.type=="ContinuousArchiving")].status}'
kubectl get backup
```
{% endstep %}
{% endstepper %}

The `postgres` chart that the Interbox chart's README suggests for dev and
staging ships no backups unless you configure WAL-G in its values.

## Restoring

Restore into a new database and point Interbox at it. Never run two Interbox
deployments against the old and the restored database at once: both would
read the same feeds and deliver to the same Aidbox.

1. **Stop Interbox.** Scale the replicas and the workspace service to zero.
2. **Restore.** On a managed service, restore to a new instance at the moment
   you choose. With CloudNativePG, create a new cluster that recovers from the
   bucket:

   ```yaml
   apiVersion: postgresql.cnpg.io/v1
   kind: Cluster
   metadata:
     name: interbox-postgres-restored
   spec:
     bootstrap:
       recovery:
         recoveryTarget:
           targetTime: "2026-11-20 09:00:00+00"
         source: origin
     externalClusters:
       - name: origin
         plugin:
           name: barman-cloud.cloudnative-pg.io
           parameters:
             barmanObjectName: interbox-backups
             serverName: interbox-postgres
     instances: 2
     plugins:
       - isWALArchiver: true
         name: barman-cloud.cloudnative-pg.io
         parameters:
           barmanObjectName: interbox-backups-restored
     storage:
       size: 50Gi
   ```

   Leave out `recoveryTarget` to restore to the last archived WAL file. Give
   the new cluster an `ObjectStore` of its own, or the same bucket under
   another path, so that its archive does not mix with the old cluster's.
3. **Point `DATABASE_URL` at the restored database** and start Interbox.

Interbox carries on from the moment you restored to:

- file-drop feeds read again each delivery they read after that moment
- units that arrived over MLLP or webhooks after that moment are gone
- the Aidbox sender sends again what it delivered after that moment

Rehearse a restore before you need one, on a copy of production, and time it.

{% content-ref url="deploy.md" %}
[Deployment](deploy.md)
{% endcontent-ref %}
