# Amazon S3

Use an S3 feed when the sending system puts files into an Amazon S3 bucket, or into an
S3-compatible store such as MinIO.

## Setup

Interbox needs read access to the bucket. Grant:

- `s3:ListBucket` on the bucket, limited to the feed's prefix if you like;
- `s3:GetObject` on the prefix;
- `kms:Decrypt` on the key, when the bucket uses SSE-KMS.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::example-bucket",
      "Condition": { "StringLike": { "s3:prefix": "clinical/*" } }
    },
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::example-bucket/clinical/*"
    }
  ]
}
```

Interbox finds its credentials in one of two ways:

| `credentials` | Interbox uses | Default |
|---|---|---|
| `"chain"` | the AWS default chain: environment keys, the shared credentials file, IRSA, EKS Pod Identity, an ECS task role, an EC2 instance role | without `endpoint` |
| `"keys"` | `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, else `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` | with `endpoint` |

On AWS, give Interbox a role and let the chain find it: no key is stored anywhere. For an
S3-compatible store, set `endpoint` and the keys.

{% hint style="info" %}
Interbox refuses `credentials: "chain"` together with `endpoint`, so AWS identity tokens never go
to a host named in the configuration.
{% endhint %}

<details>
<summary>EKS Pod Identity</summary>

1. Install the Pod Identity agent on the cluster:

   ```sh
   aws eks create-addon --cluster-name my-cluster --addon-name eks-pod-identity-agent
   ```

2. Create an IAM role that EKS pods can assume, with the policy above attached:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": { "Service": "pods.eks.amazonaws.com" },
         "Action": ["sts:AssumeRole", "sts:TagSession"]
       }
     ]
   }
   ```

3. Associate the role with the service account Interbox runs as:

   ```sh
   aws eks create-pod-identity-association \
     --cluster-name my-cluster \
     --namespace interbox \
     --service-account interbox \
     --role-arn arn:aws:iam::111122223333:role/interbox-s3-read
   ```

4. Run Interbox under that service account (`serviceAccountName: interbox`) and leave
   `credentials` unset.

With IRSA instead, annotate the service account with
`eks.amazonaws.com/role-arn: arn:aws:iam::111122223333:role/interbox-s3-read`; the chain picks it
up the same way.

</details>

A missing identity or permission fails each poll with an error that says what is missing.
Interbox skips no file over it, and reads as soon as the access is fixed.

## Configuration

```ts
import { env } from "@health-samurai/interbox";
import { aidbox, fhirItems, skipUnchanged } from "@health-samurai/interbox/aidbox";
import { pipeline, postgresStore } from "@health-samurai/interbox/chain";
import type { Bundle, Resource } from "@health-samurai/interbox/fhir/4.0.1";
import { deliveryEnd, fileDropSource, ndjson, records, s3, unpack, type NdjsonRecord } from "@health-samurai/interbox/files";

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
      transport: s3({ bucket: env("BUCKET"), prefix: "clinical" }),
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
| `region` | | `S3_REGION` or `AWS_REGION` from Interbox's environment, else `us-east-1`; with `endpoint`, the region an `s3.<region>.amazonaws.com` address names, else `auto` | the bucket's region, whatever `credentials` is; a wrong one fails with an error naming the right one |
| `endpoint` | for an S3-compatible store | | the store's URL; unset means Amazon S3 |
| `credentials` | | `"chain"`, or `"keys"` with `endpoint` | see [Setup](#setup) |
| `timeout` | | `30s` | the longest Interbox waits for any one answer |

To try a feed locally, run an S3-compatible store such as MinIO, point `endpoint` at it, and set
`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` to its keys.

{% hint style="warning" %}
With `endpoint` unset, Interbox refuses to read when `S3_ENDPOINT` or `AWS_ENDPOINT` is set in the
environment: the transport would ignore the variable and read from AWS, which is rarely what was
meant. Name the endpoint on the transport instead.
{% endhint %}

## Files Interbox cannot read

- **Archived files.** Interbox skips a file in Glacier Flexible Retrieval or Glacier Deep Archive
  and logs why. Restoring it is not enough, since the listing still shows it archived: to have it
  read, copy the restored file to a key in another storage class. Glacier Instant Retrieval reads
  like any other file.
- **Files encrypted with your own key (SSE-C).** Interbox never has that key, so it skips the file.
  Default encryption (SSE-S3) and KMS keys (SSE-KMS) work.

## Network

HTTPS 443 to `s3.<region>.amazonaws.com` or to `endpoint`. With `"chain"`, also to the AWS identity
endpoint in use: STS or instance metadata. See [Network Access](../../ops/network.md) for egress
rules.

Deliveries, file formats and pipeline settings shared by every storage are on
[Reading Files from Storage](README.md).
