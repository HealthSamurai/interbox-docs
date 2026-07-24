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
kubectl set env deploy/interbox-pg POSTGRES_USER=postgres POSTGRES_PASSWORD=postgres POSTGRES_DB=postgres
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
  data:
    DATABASE_URL: "postgres://postgres:postgres@interbox-pg:5432/interbox?sslmode=disable"
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
curl -sk -o /dev/null -D - https://interbox.localhost:8443/api/messages | grep -iE '^HTTP|^location'
#   HTTP/1.1 302 ... Location: .../oauth2/start?rd=/api/messages  -> then on to Dex

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
