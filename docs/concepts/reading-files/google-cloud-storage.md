# Google Cloud Storage

Use a Cloud Storage feed when the sending system puts files into a Google Cloud Storage bucket.

## Setup

Interbox reads the bucket as the Google identity it runs as: on GKE, the Kubernetes service
account through Workload Identity; elsewhere on Google Cloud, the attached service account. No
key is stored anywhere.

Grant that identity `roles/storage.objectViewer` on the bucket, or `storage.objects.list` and
`storage.objects.get`.

<details>
<summary>Workload Identity on GKE</summary>

1. Enable Workload Identity Federation for GKE on the cluster and its node pool.
2. Run Interbox under its own Kubernetes service account, for example `interbox` in the
   `interbox` namespace (`serviceAccountName: interbox`).
3. Grant that service account read access to the bucket:

   ```sh
   gcloud storage buckets add-iam-policy-binding gs://example-bucket \
     --role=roles/storage.objectViewer \
     --member=principal://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/example-project.svc.id.goog/subject/ns/interbox/sa/interbox
   ```

   `123456789012` is the project number and `example-project` the project ID.

</details>

A missing identity or permission fails each poll with an error that says what is missing.
Interbox skips no file over it, and reads as soon as the access is fixed.

## Configuration

```ts
import { env } from "@health-samurai/interbox";
import { aidbox, fhirItems, skipUnchanged } from "@health-samurai/interbox/aidbox";
import { pipeline, postgresStore } from "@health-samurai/interbox/chain";
import type { Bundle, Resource } from "@health-samurai/interbox/fhir/4.0.1";
import { deliveryEnd, fileDropSource, ndjson, records, gcs, unpack, type NdjsonRecord } from "@health-samurai/interbox/files";

const toAidbox = aidbox({
  url: env("AIDBOX_URL"),
  auth: { kind: "basic", user: env("AIDBOX_CLIENT_ID", "root"), password: env("AIDBOX_CLIENT_SECRET") },
});

function bundleToResources(row: NdjsonRecord): Resource[] {
  const bundle = row as unknown as Bundle;
  return (bundle.entry ?? []).flatMap((entry) => (entry.resource === undefined ? [] : [entry.resource]));
}

pipeline("clinical")
  .source(
    fileDropSource({
      transport: gcs({ bucket: env("BUCKET"), prefix: "clinical" }),
    }),
  )
  .step(unpack())
  .step(ndjson())
  .store(postgresStore({ codec: "json" }))
  .step(deliveryEnd())
  .step(records(bundleToResources))
  .step(fhirItems())
  .step(skipUnchanged())
  .sender(toAidbox);
```

| Field | Required | Default | Sets |
|---|---|---|---|
| `bucket` | yes | | |
| `prefix` | yes | | the feed; `""` for the whole bucket |
| `endpoint` | | | an emulator's URL, for tests only; Interbox sends it no credentials |
| `timeout` | | `30s` | the longest Interbox waits for any one answer |

{% hint style="warning" %}
With `endpoint` unset, Interbox refuses to read when `STORAGE_EMULATOR_HOST` is set in the
environment, since the client would send requests to the emulator. Name the endpoint on the
transport instead.
{% endhint %}

To try a feed locally, run [fake-gcs-server](https://github.com/fsouza/fake-gcs-server) and point
`endpoint` at it.

## Files Interbox cannot read

- **Files replaced or deleted while they are read.** Interbox reads the generation of a file it
  listed. A file replaced since is skipped, `version_changed`, and a top-level file is then read in
  its new generation at the next poll; a file deleted since is skipped, `not_found`.
- **Files encrypted with your own key.** Interbox never has a customer-supplied key, so it skips
  the file. Google-managed and Cloud KMS keys work.

## Network

HTTPS 443 to `storage.googleapis.com`, and to the metadata server for the identity token. See
[Network Access](../../ops/network.md) for egress rules.

Deliveries, file formats and pipeline settings shared by every storage are on
[Reading Files from Storage](README.md).
