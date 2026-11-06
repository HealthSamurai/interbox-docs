# Azure Blob Storage

Use an Azure feed when the sending system puts files into an Azure Blob Storage container.

## When Interbox reads a file

On an account with a hierarchical namespace (Data Lake Storage Gen2), a file is visible while the
sending system is still writing it. Interbox treats every account the same way: it reads a file
once its size and modification time match across two polls and it is at least `minFileAge` old;
an empty file waits at least five minutes. A delivery's marker file follows the same rule. After
a restart every file waits one poll, since Interbox has no earlier listing to compare.

Set `minFileAge` when a sending system can pause mid-file for longer than `pollInterval`.

## Setup

Interbox needs the **Storage Blob Data Reader** role on the container or the account, and no
other grant.

| `credentials` | Interbox uses | Default |
|---|---|---|
| `"ambient"` | the identity Interbox itself runs as: a workload identity on AKS, else a managed identity (`AZURE_CLIENT_ID` names a user-assigned one). Interbox tries nothing else: no client secret in the environment and no developer login | yes |
| `"key"` | the account key in `AZURE_STORAGE_KEY` | |

Prefer `"ambient"`: no key is stored anywhere.

{% hint style="info" %}
Interbox refuses `credentials: "ambient"` together with `endpoint`, so Azure identity tokens never
go to a host named in the configuration.
{% endhint %}

<details>
<summary>Workload identity on AKS</summary>

1. Enable the OIDC issuer and workload identity on the cluster:

   ```sh
   az aks update --resource-group example-rg --name example-aks \
     --enable-oidc-issuer --enable-workload-identity
   ```

2. Create a user-assigned managed identity and let Interbox's service account use it:

   ```sh
   az identity create --resource-group example-rg --name interbox-reader
   az identity federated-credential create --resource-group example-rg \
     --identity-name interbox-reader --name interbox \
     --issuer "$(az aks show -g example-rg -n example-aks --query oidcIssuerProfile.issuerUrl -o tsv)" \
     --subject system:serviceaccount:interbox:interbox
   ```

3. Give the identity read access to the container:

   ```sh
   az role assignment create --role "Storage Blob Data Reader" \
     --assignee "$(az identity show -g example-rg -n interbox-reader --query clientId -o tsv)" \
     --scope "/subscriptions/<subscription-id>/resourceGroups/example-rg/providers/Microsoft.Storage/storageAccounts/examplestorage/blobServices/default/containers/inbound"
   ```

4. Annotate the service account with the identity's client ID, and label the pod:

   ```yaml
   apiVersion: v1
   kind: ServiceAccount
   metadata:
     name: interbox
     namespace: interbox
     annotations:
       azure.workload.identity/client-id: "<client-id>"
   ```

   ```yaml
   metadata:
     labels:
       azure.workload.identity/use: "true"
   spec:
     serviceAccountName: interbox
   ```

</details>

A missing identity or permission fails each poll with an error that says what is missing.
Interbox skips no file over it, and reads as soon as the access is fixed.

## Configuration

```ts
import { env } from "@health-samurai/interbox";
import { aidbox, fhirItems, skipUnchanged } from "@health-samurai/interbox/aidbox";
import { pipeline, postgresStore } from "@health-samurai/interbox/chain";
import type { Bundle, Resource } from "@health-samurai/interbox/fhir/4.0.1";
import { deliveryEnd, fileDropSource, ndjson, records, azure, unpack, type NdjsonRecord } from "@health-samurai/interbox/files";

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
      transport: azure({ account: "examplestorage", container: "inbound", prefix: "clinical" }),
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
| `account` | yes | | the storage account name |
| `container` | yes | | |
| `prefix` | yes | | the feed; `""` for the whole container |
| `endpoint` | | | another URL, such as an emulator's; unset means `https://<account>.blob.core.windows.net` |
| `credentials` | | `"ambient"` | see [Setup](#setup) |
| `timeout` | | `30s` | the longest Interbox waits for any one answer |
| `minFileAge` | | `0s` | how old a file must be before Interbox reads it |

To try a feed locally, run [Azurite](https://github.com/Azure/Azurite), point `endpoint` at its
blob service, and set `credentials: "key"` with Azurite's account key in `AZURE_STORAGE_KEY`.

## Files Interbox cannot read

- **Archived files.** A blob in the Archive tier cannot be read until someone moves it back to the
  Hot or Cool tier. Interbox skips it and logs why.
- **Append and page blobs.** Interbox reads block blobs, which every upload tool writes. An append
  or page blob can still be growing when it is listed, so Interbox skips it and logs its type. A
  marker file that is an append or page blob rejects its folder.
- **Blobs encrypted with your own key.** Interbox never has a customer-provided key, so it skips a
  blob encrypted with one and logs why.

## Network

HTTPS 443 to `<account>.blob.core.windows.net` or to `endpoint`. With `"ambient"`, also to the Azure
identity endpoint: instance metadata or Microsoft Entra ID. See [Network Access](../../ops/network.md) for egress rules.

Deliveries, file formats and pipeline settings shared by every storage are on
[Reading Files from Storage](README.md).
