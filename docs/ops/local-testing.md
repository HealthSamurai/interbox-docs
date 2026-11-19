# Testing Locally with k3d

You can rehearse the full secure deployment — internal-style ingress, TLS, and an
SSO login gate — on a laptop with [k3d](https://k3d.io) (k3s in Docker) before
you touch a real cloud. It exercises the same chart and the same
[secure-access](secure-access.md) wiring; only the identity provider and the
cert issuer differ from production.

> The credentials and self-signed certs here are **throwaway, local-only**. Never
> reuse them anywhere real.

**Prerequisites:** `k3d`, `kubectl`, `helm`, `docker`, `openssl`.

## 1. Cluster + ingress controller

k3d ships Traefik; swap it for `ingress-nginx` (so the oauth2-proxy auth
annotations work as they do on AKS), and map host ports to the ingress:

```sh
k3d cluster create interbox \
  --k3s-arg "--disable=traefik@server:0" \
  -p "8081:80@loadbalancer" -p "8443:443@loadbalancer" --wait

helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm install ingress-nginx ingress-nginx/ingress-nginx \
  -n ingress-nginx --create-namespace \
  --set controller.service.type=LoadBalancer
```

`*.localhost` resolves to loopback, so `interbox.localhost:8443` reaches the
ingress with no `/etc/hosts` edits.

## 2. Postgres

A throwaway in-cluster Postgres is enough (its `postgres` superuser has
`CREATEDB`, so the engine self-creates the `interbox` db):

```sh
kubectl create deploy interbox-pg --image=postgres:18-alpine
kubectl set env deploy/interbox-pg POSTGRES_USER=postgres POSTGRES_HOST_AUTH_METHOD=trust POSTGRES_DB=postgres
kubectl expose deploy/interbox-pg --port=5432
```

## 3. cert-manager + a local CA

Install cert-manager, then create a **self-signed CA** issuer — the local stand-in
for the internal CA you'd use for a private host in production:

```sh
helm repo add jetstack https://charts.jetstack.io
helm install cert-manager jetstack/cert-manager \
  -n cert-manager --create-namespace --set crds.enabled=true
```

```yaml
# ca-issuer.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: selfsigned }
spec: { selfSigned: {} }
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata: { name: local-ca, namespace: cert-manager }
spec:
  isCA: true
  commonName: interbox-local-ca
  secretName: local-ca
  issuerRef: { name: selfsigned, kind: ClusterIssuer, group: cert-manager.io }
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: local-ca }
spec: { ca: { secretName: local-ca } }
```

`kubectl apply -f ca-issuer.yaml`. Now an ingress annotated
`cert-manager.io/cluster-issuer: local-ca` gets a cert automatically.

## 4. An identity provider (Dex)

In production this is Entra ID / Okta. Locally, run [Dex](https://dexidp.io) with
one static test user and an OIDC client for the dashboard. Generate the password
hash, then serve Dex behind the ingress:

```sh
docker run --rm httpd:2-alpine htpasswd -bnBC 10 "" 'password' | tr -d ':\n' | sed 's/\$2y/\$2a/'
```

Dex config (issuer `https://dex.localhost:8443/dex`, client
`interbox-dashboard`, redirect `https://interbox.localhost:8443/oauth2/callback`,
static user `user@interbox.local` with the hash above), exposed via an nginx
Ingress on `dex.localhost` with `cert-manager.io/cluster-issuer: local-ca`.

## 5. The login gate (oauth2-proxy)

Deploy oauth2-proxy pointed at Dex. The key flags (split browser-facing vs
in-cluster endpoints so it works without cluster DNS for `dex.localhost`):

```text
--provider=oidc  --skip-oidc-discovery=true
--oidc-issuer-url=https://dex.localhost:8443/dex
--login-url=https://dex.localhost:8443/dex/auth               # browser
--redeem-url=http://dex.dex.svc.cluster.local:5556/dex/token  # in-cluster
--oidc-jwks-url=http://dex.dex.svc.cluster.local:5556/dex/keys # in-cluster
--client-id=interbox-dashboard  --redirect-url=https://interbox.localhost:8443/oauth2/callback
--cookie-secret=<32 chars>  --cookie-secure=true  --email-domain=*
```

Expose it at `interbox.localhost/oauth2` (same host as the dashboard, for cookies
+ callback).

## 6. Interbox

Install the chart with the secure values (see [secure-access](secure-access.md)):

```yaml
config:
  AIDBOX_URL: "http://aidbox.placeholder.svc:8080"     # no Aidbox locally
  INTERBOX_WORKSPACE_GIT_URL: "https://github.com/HealthSamurai/interbox-workspace"
secrets:
  DATABASE_URL: "postgres://postgres@interbox-pg:5432/interbox?sslmode=disable"
  AIDBOX_CLIENT_SECRET: "placeholder"
ingress:
  enabled: true
  className: nginx
  host: interbox.localhost
  tls:
    - { hosts: [interbox.localhost], secretName: interbox-tls }
  annotations:
    cert-manager.io/cluster-issuer: local-ca
    nginx.ingress.kubernetes.io/auth-url: "http://oauth2-proxy.default.svc.cluster.local:4180/oauth2/auth"
    nginx.ingress.kubernetes.io/auth-signin: "https://interbox.localhost:8443/oauth2/start?rd=$escaped_request_uri"
```

```sh
helm repo add healthsamurai https://healthsamurai.github.io/helm-charts
helm install interbox healthsamurai/interbox -f values.yaml
```

## 7. Verify

```sh
# unauthenticated -> redirected to the login gate (SSO enforced)
curl -sk -o /dev/null -D - https://interbox.localhost:8443/api/pipelines | grep -iE '^HTTP|^location'
#   HTTP/1.1 302 ... Location: .../oauth2/start?rd=/api/pipelines  -> then on to Dex

# TLS served by the cert-manager CA
echo | openssl s_client -connect interbox.localhost:8443 -servername interbox.localhost 2>/dev/null \
  | openssl x509 -noout -issuer
#   issuer=CN=interbox-local-ca
```

Then open `https://interbox.localhost:8443/` (accept the self-signed warning), log
in as `user@interbox.local` / `password`, and you land on the dashboard.

## What changes on real cloud

| Local (here) | Production (e.g. AKS) |
| ------------ | --------------------- |
| ingress-nginx (mapped host ports) | ingress-nginx behind an **internal** LB, or AGIC |
| self-signed CA issuer | **DNS-01** (public zone) or your **internal CA** / Key Vault |
| **Dex** + static user | **Entra ID / Okta** (real OIDC app) |
| in-cluster Postgres pod | **managed Postgres** (private endpoint, `sslmode=require`) |

Everything else — the chart, the ingress annotations, cert-manager, oauth2-proxy
— is identical. Tear down with `k3d cluster delete interbox`.


## Availability with two replicas

Create the cluster with `--agents 2`. Use a coordinated engine, compatible workspace
and chart, one shared database, and a license covering at least two instances.
Apply these additional chart values:

```yaml
replicaCount: 2
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 0
    maxUnavailable: 1
preStopDelaySeconds: 5
terminationGracePeriodSeconds: 30
probe:
  readiness:
    path: /api/ready
    periodSeconds: 2
    failureThreshold: 1
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            app: interbox
        topologyKey: kubernetes.io/hostname
```

Keep startup and liveness on `/api/health`; `/api/ready` also checks the local engine.
The pre-stop delay allows routing to drain and consumes part of the termination grace.
`maxSurge: 0` avoids an extra scheduled replica, but a terminating process can still
hold a license slot until it exits.

During source-owner deletion and rolling updates, verify Service availability,
delivery counts and persisted cursors. Test file-drop takeover separately with a
local S3-compatible server: its ownership leases differ from custom sources.

### First upgrade from an uncoordinated version

Follow the [initial upgrade procedure](updating.md#first-upgrade-to-coordinated-runtime-generations):
stop every legacy engine/API and confirm termination before starting coordinated
releases. Enable rolling updates and multiple replicas afterward.

### Coordinated revision changes

Engines prepare a candidate, publish the desired generation, then drain old workers
and actions before activation. Unclaimed queued work uses the new configuration.
A failed preparation keeps the active runtime running unless another replica has
published a new desired generation; incompatible pods then stop and become unready.

Generation identity covers workspace code, engine/Bun and
[business configuration](workspace.md#configuration-across-replicas). Activating a
new implementation retires the previous one. To roll back a retired image or
configuration, deploy a fresh `INTERBOX_RUNTIME_ROLLBACK_INTENT` and keep it stable
for that rollout. Explicit branch selection can restore old workspace code without
restoring retired images or configuration.

### A cutover blocked by a missing pod

A lost connection or heartbeat does not prove an old worker stopped. Cutover waits
for confirmed worker shutdown or an operator's termination confirmation. Worker takeover
within a stable generation still works; unfinished actions retain ownership even there.

A container restart inside the same pod needs no confirmation. When the engine starts
again under the same `INTERBOX_WORKSPACE_INSTANCE`, and the database session of the
earlier engine process has ended, the new process releases the membership the earlier
one left and records that in the audit trail. This covers an engine killed for memory
or one that exited because a worker did not stop. A pod replaced by a new pod has a new
UID, and an unfinished action is never released this way: both follow the steps below.

If all pods are `NotReady`, the Service may have no ready endpoints, including for
the dashboard and operator API. Reach a running pod directly through a local tunnel:

```sh
kubectl -n <namespace> port-forward --address 127.0.0.1 pod/<running-pod> 3001:3001
```

Use your authenticated operator client through the tunnel, preserving the configured
public Host and Origin. Port-forwarding does not bypass authentication or those checks.
Choose a pod whose API is responding; a paused engine does not necessarily stop its API.

Inspect `GET /api/runtime` through the authenticated operator API. It returns
`desired`, `active`, `blockers`, unfinished `actions` and `unreachable` members (see
[an update refused for a silent member](#an-update-refused-for-a-silent-member)). Blockers identify member
`id`, `generation`, `instance`, `podIdentity`, `processId` and blocking reason. Both
engine and API must use the pod UID as `INTERBOX_WORKSPACE_INSTANCE`.

Engine logs name blocking actions and their pods, with worker blockers in the structured
`blockers` field. An unchanged wait is reported every 30 seconds. From 30 seconds on, the
report is an error and also becomes the engine's reload error on the Instances page until the
switch completes. `observedWaitMs` measures
how long that engine has observed the blockage, not cluster-wide downtime. An action's
timeout requests cancellation; it does not prove that an action ignoring the signal stopped.

1. Match the member and pod UID in the response to the old workload. A replacement with the
   same pod name is a different pod; check its UID.
2. Confirm through the deployment's control plane that the old pod has been deleted and its
   containers have terminated. For a host process, confirm that that process has exited.
   Losing network access, observing `NotReady`, or force-deleting a pod object while its node
   might still run the container is insufficient evidence.
3. Record that evidence and confirm that exact member:

```http
POST /api/runtime/members/<member-uuid>/confirm-termination
Content-Type: application/json

{
  "terminationVerified": true,
  "generation": "<blocked-generation>",
  "podIdentity": "<terminated-pod-uid>",
  "proof": "<how and when actual container or process termination was confirmed>"
}
```

Interbox audits the session, member and proof, and keeps a finished membership with
its audit for 30 days. Confirmation releases only the matching
cutover/action blocker and preserves queue data. There is no Kubernetes fencing
controller: if termination is uncertain, leave the blocker and restore communication
so the process can drain. Accepted external requests may still finish after termination;
custom writes need destination idempotency or fencing.

If a workspace migration fails after drain, old workers stay stopped. Repair the
database and retry the same migration. To replace the migration itself, deploy the
repaired workspace and restart the engines with a fresh `INTERBOX_RUNTIME_ROLLBACK_INTENT`:
an engine that starts with an intent this deployment has not used prepares the current
workspace instead of retrying the failed one. Keep the value until every engine has
restarted; consumed intents cannot be reused.

### An update refused for a silent member

A pod lost without a clean stop, for example to node loss, leaves its member `running`.
A running member of the active generation that has not reported for 60 seconds is
listed under `unreachable` in `GET /api/runtime`. While one exists, engines refuse to
publish a new generation and the active one keeps processing; otherwise the update
would stop every pod and then wait for the lost one. The refusing engine logs it at
ERROR and shows it as its reload error. Confirm the member's termination with the
[steps above](#a-cutover-blocked-by-a-missing-pod), using the member's own `generation`;
engines then prepare the update again. They also check every 5 seconds whether the member
reports again, for example after a database outage, and then prepare the update with no
confirmation. They do not prepare it again while the member stays silent.
