# Securing Dashboard Access

The Interbox dashboard/API has **no built-in login**. Anything that can reach its
port sees message content (PHI), the error queue, and the assistant. So for any
real deployment it must be:

1. **Private** — never on the public internet; reached over a VPN/VNet via an
   *internal* ingress.
2. **Encrypted** — TLS in front.
3. **Authenticated** — a login gate (SSO) in front, because the app has none.

All three are configured with **Helm values + separately-installed cluster
components** — no changes to the Interbox chart itself.

> Because there is no login, anyone who gets past the gate above has whatever the
> dashboard is configured to allow — including editing the workspace, if you have
> turned that on. That is `INTERBOX_WORKSPACE_ACCESS`, and it defaults to
> read-only; see [The Workspace](workspace.md).

## The pieces

- **Ingress controller** (e.g. `ingress-nginx`, or a cloud one like AGIC) — the
  cluster's reverse proxy. Routes your hostname to the dashboard Service and
  terminates TLS. For a private dashboard, run it behind an **internal** load
  balancer so it has no public IP.
- **cert-manager** — obtains and auto-renews the TLS certificate into a Secret.
  An **Issuer/ClusterIssuer** decides *who signs* the cert.
- **oauth2-proxy** — the login gate. No valid session → it redirects the user to
  log in, then sets a cookie. Speaks OIDC.
- **An OIDC identity provider** — the thing that actually authenticates the user
  (Entra ID / Azure AD, Okta, Google, Keycloak, …). oauth2-proxy trusts it.

None of these ship with the Interbox chart — they are **cluster infrastructure
you install once** and reuse across apps.

## How a request flows

```text
Browser → ingress (terminates TLS)
        → ingress asks oauth2-proxy "is this user logged in?"
            → no session → 302 redirect to the identity provider's login
            → user logs in → back to oauth2-proxy → sets a session cookie
        → ingress now allows the request → Interbox dashboard
```

## The Interbox values

Everything above is wired through the chart's `ingress` values — no chart edit:

```yaml
ingress:
  enabled: true
  className: <your-internal-ingress-class>       # a controller behind an internal LB
  host: interbox.internal.example
  tls:
    - hosts: [interbox.internal.example]
      secretName: interbox-tls
  annotations:
    # TLS: cert-manager issues + renews into the secret above
    cert-manager.io/cluster-issuer: <your-issuer>
    # SSO: nginx asks oauth2-proxy before serving; no session -> redirect to login
    nginx.ingress.kubernetes.io/auth-url: "http://oauth2-proxy.<ns>.svc.cluster.local:4180/oauth2/auth"
    nginx.ingress.kubernetes.io/auth-signin: "https://interbox.internal.example/oauth2/start?rd=$escaped_request_uri"
```

The exact value keys live in the
[chart README](https://github.com/HealthSamurai/helm-charts/tree/main/interbox);
this page explains the surrounding setup.

## TLS: choosing an issuer

TLS terminates at the ingress. cert-manager fills the `interbox-tls` secret; how
depends on where the host's DNS lives:

- **Public DNS zone** → cert-manager **ACME DNS-01** (e.g. the Azure DNS / Route53
  / Cloud DNS solver). Works even when the host resolves to a *private* IP,
  because DNS-01 only writes a TXT record — no inbound reachability needed.
- **Private-only DNS** → ACME/Let's Encrypt **cannot** validate it (it resolves
  public DNS). Use an **internal CA** issuer (your org PKI, a cert-manager `ca`
  ClusterIssuer, or a Key Vault / secrets-manager cert) instead.
- **Bring your own cert** → skip cert-manager: `kubectl create secret tls
  interbox-tls --cert=… --key=…` and reference it in `ingress.tls`.

> A common mistake is pointing an internal-only host at Let's Encrypt HTTP-01 —
> it will never validate. Internal host ⇒ DNS-01 (public zone) or an internal CA.

## SSO: the identity provider

oauth2-proxy needs an OIDC provider. In production that's your IdP — e.g. **Entra
ID (Azure AD)**: register an application, set its redirect URI to
`https://<host>/oauth2/callback`, and give oauth2-proxy the issuer URL, client ID,
and client secret. Any OIDC provider works the same way.

Because the dashboard has no built-in RBAC, **the SSO layer is your access
control** — scope who can log in at the identity provider, and keep an audit log.

## Deployment gotchas worth knowing

- **Managed Postgres extensions** — Interbox needs `pg_trgm` + `btree_gist`. Some
  managed services require **allowlisting extensions** before `CREATE EXTENSION`
  works (e.g. Azure Database for PostgreSQL: set the server parameter
  `azure.extensions` to include `PG_TRGM,BTREE_GIST`). Otherwise the boot
  migration fails.
- **TLS to Postgres** — put `sslmode=require` (or `verify-full` + the provider CA)
  in `DATABASE_URL`. See the chart's
  [PREREQUISITES](https://github.com/HealthSamurai/helm-charts/blob/main/interbox/PREREQUISITES.md).

## See also

- [Testing Locally with k3d](local-testing.md) — rehearse this whole path (ingress
  + TLS + SSO) on a laptop before touching a real cloud.
- [Deployment](deploy.md) — the chart, install, and the engine-specific rollout
  facts.
- [System Requirements](sizing.md) — sizing the pod, Postgres, and Aidbox.
