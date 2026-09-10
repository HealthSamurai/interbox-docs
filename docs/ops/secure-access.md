# Securing Dashboard Access

The Interbox dashboard and its API reach message content (PHI), the error queue,
a read-only SQL console and an assistant with file and shell tools. Three things
protect them, and only the first ships with Interbox:

1. **A login** — built in, and **on by default**. This page starts there.
2. **Private** — never on the public internet; reached over a VPN/VNet via an
   *internal* ingress.
3. **Encrypted** — TLS in front.

The login does not replace the other two. It authenticates whoever reaches the
port; it does not decide who can reach it.

> There is no built-in RBAC. Everyone who signs in gets everything the dashboard
> is configured to allow — including editing the workspace, if you have turned
> that on. That is `INTERBOX_WORKSPACE_ACCESS`, and it defaults to read-only; see
> [The Workspace](workspace.md).

## Signing in

Two ways in, and you can enable either or both.

**An administrator password.** One shared account, no username. With single
sign-on also enabled it is not the front door: the sign-in screen offers the
provider, and the password sits behind a **Use the administrator password**
link that replaces it. With single sign-on off, the box is the screen. Set
`INTERBOX_AUTH_ADMIN_PASSWORD`; it must be at least 20 characters, and Interbox
will never invent one for you — an unset password is a refusal to serve the
dashboard, not a generated secret printed in a log where it lives forever.
Generate one with:

```sh
openssl rand -base64 24
```

That recipe avoids `$` by construction, which matters because `--env-file`
expands `$` as a variable reference and would otherwise mangle the password
silently.

**Single sign-on.** Point Interbox at any OpenID Connect provider:

```sh
INTERBOX_AUTH_ISSUER=https://idp.example.com
INTERBOX_AUTH_CLIENT_ID=<the client you registered>
INTERBOX_AUTH_CLIENT_SECRET=<optional; PKCE carries a public client alone>
```

Register `https://<your host>/api/auth/callback` as the redirect URI.

#### The sign-in button names your provider

With single sign-on enabled the button reads **Sign in with Google**, **Sign in
with Okta**, and so on. That name is derived from `INTERBOX_AUTH_ISSUER` alone:
nothing is fetched to work it out. Where that is the wrong name — which it is for
any provider you run yourself — you can say what it should be instead, at the end
of this section.

Interbox knows the major hosted providers by their issuer host, and only by
that: the host is what proves the name, so nothing else about an issuer can
borrow a brand the host does not own. **Every other provider is named by the
issuer's host**, self-hosted ones included — an issuer at
`https://sso.internal.example` gives you **Sign in with sso.internal.example**,
and a non-default port travels with it (`sso.internal.example:8443`).

That is deliberately conservative, and it is the wrong answer for a provider you
run yourself. Aidbox, Keycloak and Dex all issue from *your* hostname, which
says nothing about the product, and no amount of inspection can honestly fix
that: everything an issuer publishes is published by the same host. So name it
yourself:

```sh
INTERBOX_AUTH_PROVIDER_LABEL=Aidbox
```

giving **Sign in with Aidbox**. It wins over the host and over the built-in
names, so it also serves an operator who would rather the button read
`Corporate SSO` than `acme.okta.com`, or who does not want their identity
provider's hostname on a page anyone can load. At most 64 characters, and
control characters are refused because it is rendered on a page.

The sign-in screen is public, so that host is visible to anyone who can reach
the page, signed in or not. It is a hostname rather than a credential, and the
same host is already visible in the redirect `/api/auth/start` sends an
anonymous visitor to — but if naming your identity provider to strangers is
more than you want to publish, the answer is to keep the page off the open
internet. See [Additional layers](#additional-layers).

#### What the issuer is, and how to find it

`INTERBOX_AUTH_ISSUER` is not an endpoint you call — it is the provider's
**identity**. It is the value the provider puts in the `iss` claim of every
token it signs, and it is the base Interbox builds everything else from.
Interbox uses it three times, and all three comparisons are exact:

1. it fetches `<issuer>/.well-known/openid-configuration`;
2. it requires that document's own `issuer` field to equal what you configured;
3. it requires every id_token's `iss` claim to equal it too.

So **don't paste the discovery URL** into this variable — Interbox appends
`/.well-known/openid-configuration` itself, and a value ending in
`/.well-known/openid-configuration` will send it looking for that path twice.

The reliable way to get the right value is to ask the provider and read the
answer back:

```sh
curl -s https://<your provider>/.well-known/openid-configuration | jq -r .issuer
```

Paste that output verbatim. A trailing slash, a difference in case, or `http`
where the provider says `https` all make it a different issuer, and the
sign-in will fail rather than quietly work.

Where to point that `curl`, by provider:

| provider | issuer |
|---|---|
| Aidbox | the Aidbox base URL, e.g. `https://aidbox.example.com` |
| Google | `https://accounts.google.com` |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant id>/v2.0` — a tenant id, never `common` |
| Auth0 | `https://<tenant>.<region>.auth0.com/` — the trailing slash is part of it |
| Keycloak | `https://<host>/realms/<realm>` |

Interbox fetches that document **server-side**, so the issuer has to be an
address the Interbox process can reach — not only one that resolves in your
browser. It must be `https` unless it is a loopback address, which is what
lets a local Dex or Aidbox rig work over plain HTTP.

If any of this is wrong, `/api/auth/start` answers `503` with "the identity
provider could not be reached" and the server log says which check failed —
unreachable, a redirect where a document was expected, or a document naming a
different issuer.

### Who may sign in

An OIDC issuer on its own admits **every account that provider will
authenticate** — for a multi-tenant provider, that is most of the internet. So
Interbox refuses to start until you say who may in:

```sh
INTERBOX_AUTH_ALLOWED_EMAILS=alice@example.com,bob@example.com
INTERBOX_AUTH_ALLOWED_DOMAINS=example.com
INTERBOX_AUTH_ALLOWED_GROUPS=interbox-operators
INTERBOX_AUTH_ALLOWED_SUBJECTS=00000000-0000-0000-0000-000000000000
```

Any one of them is enough. Domains match the label after the last `@` exactly —
`example.com` does not admit `notexample.com` or `mail.example.com` — and an
email rule additionally requires the provider to have marked the address
verified.

The group example above is a *name*, which is what some providers put in the
token. Others put an opaque id, and a name will never match there — Entra ID is
one of those, so see [its worked example](#worked-example-microsoft-entra-id)
before writing a group rule against it.

`INTERBOX_AUTH_REQUIRED_CLAIMS` is a JSON object that every identity must match:

```sh
INTERBOX_AUTH_REQUIRED_CLAIMS={"tid":"<your tenant id>"}
```

It **narrows** who gets in; it cannot admit anyone by itself. That is deliberate.
The claims an operator reaches for first — `aud` ("only my application") and
`iss` ("only my provider") — are already true of every token the verifier
accepts, so pinning one and nothing else would have admitted the whole provider
while looking like a restriction.

> `INTERBOX_AUTH_ALLOWED_GROUPS` is only safe on a **single-tenant** issuer. A
> group name is a string the identity provider controls, and on a multi-tenant
> or self-service-group provider the person signing in may be able to choose it.
> Pair it with `INTERBOX_AUTH_REQUIRED_CLAIMS` pinning the tenant, or match on
> subjects instead. Providers that emit group **IDs** rather than names are not
> affected.

#### Will my provider give me an email rule?

`INTERBOX_AUTH_ALLOWED_EMAILS` and `_DOMAINS` need the provider to send
`email_verified` as the boolean `true`, not just `email`. Interbox will not
trust an address the provider has not vouched for, because an unverified
address is a value the account holder may have typed themselves.

OpenID Connect defines both claims as part of the `email` scope, so a
conforming provider that supports that scope returns them and email and domain
rules work — Google being the common case. Two providers in this document do
not:

- **Aidbox** sends `email` and no `email_verified`.
- **Microsoft Entra ID** does not send it either, and its `email` may come from
  an unverified `otherMails` entry.

For both, match on `INTERBOX_AUTH_ALLOWED_SUBJECTS` instead.

Rather than assume, check the provider you actually have. Complete one sign-in,
take the `id_token` from the token response, and look at its claims — the
middle segment of the JWT is base64url-encoded JSON:

```sh
echo '<the id_token>' | cut -d. -f2 | base64 -d 2>/dev/null | jq .
```

If `email_verified` is `true`, email and domain rules will work. If it is
absent or a string, they will not, and every sign-in is refused with
`403` — which looks like a rejected account rather than a configuration
mistake, so it is worth checking before you deploy the rule.

### Worked example: Google

In the Google Cloud console, under **APIs & Services → Credentials**, create an
**OAuth client ID** of type *Web application* and add one authorised redirect
URI:

```
https://interbox.internal.example/api/auth/callback
```

Then:

```sh
INTERBOX_PUBLIC_URL=https://interbox.internal.example
INTERBOX_AUTH_ISSUER=https://accounts.google.com
INTERBOX_AUTH_CLIENT_ID=<client id>.apps.googleusercontent.com
INTERBOX_AUTH_CLIENT_SECRET=<client secret>
INTERBOX_AUTH_ALLOWED_DOMAINS=example.com
INTERBOX_AUTH_REQUIRED_CLAIMS={"hd":"example.com"}
INTERBOX_AUTH_ADMIN_ENABLED=false
```

The secret is needed here: a Google *Web application* client is confidential
and its token endpoint expects one.

**The allow-rule is the whole access control, and Google is the provider that
makes that most obvious** — without one, every Google account on earth is an
account on this instance, which is why Interbox refuses to start. Setting
`INTERBOX_AUTH_ALLOWED_DOMAINS` to a domain you own is the control; setting it
to `gmail.com` is not a restriction at all.

`INTERBOX_AUTH_REQUIRED_CLAIMS={"hd":"example.com"}` is worth adding on top for
a Workspace domain. `hd` is the hosted-domain claim Google puts in the token
for a Workspace account, so pinning it means a personal account that merely
*has* an address at your domain cannot get in. It narrows; the domain rule is
still what admits.

Google marks `email_verified`, which Interbox requires for any email or domain
rule, so this configuration works as written.

### Worked example: Aidbox

Aidbox is an OpenID Connect provider in its own right, so an Aidbox you already
run can be the thing that signs people in — no third-party IdP, no extra
component. This walkthrough was verified end to end against a licensed Aidbox.

**1. Find the issuer.** It is whatever Aidbox publishes about itself, and
Interbox compares it byte for byte:

```sh
curl -s https://aidbox.example.com/.well-known/openid-configuration | jq -r .issuer
```

Copy that value exactly. Interbox fetches this document **server-side**, so the
issuer must be an address the Interbox process itself can reach, not only the
browser.

**2. Register a client in Aidbox.** Through the REST API (or the Aidbox
console, same resource):

```json
PUT /Client/interbox-dashboard
{
  "resourceType": "Client",
  "id": "interbox-dashboard",
  "secret": "<generate one: openssl rand -base64 24>",
  "first_party": true,
  "grant_types": ["authorization_code"],
  "auth": {
    "authorization_code": {
      "redirect_uri": "https://interbox.internal.example/api/auth/callback",
      "token_format": "jwt",
      "access_token_expiration": 3600,
      "refresh_token": false
    }
  }
}
```

| field | why |
|---|---|
| `grant_types: ["authorization_code"]` | the only flow Interbox uses |
| `auth.authorization_code.redirect_uri` | must equal `<INTERBOX_PUBLIC_URL>/api/auth/callback` exactly |
| `secret` | Interbox sends it as HTTP Basic at the token endpoint |
| `first_party: true` | skips Aidbox's consent screen — without it every sign-in stops on a "do you allow this application" page |
| `refresh_token: false` | Interbox never asks for one, and never stores provider tokens |

**3. Make sure the people signing in exist as Aidbox `User` resources.** The
`User` id is what Interbox admits on, so note it:

```json
PUT /User/alice
{ "resourceType": "User", "id": "alice", "email": "alice@example.com", "password": "..." }
```

**4. Configure Interbox:**

```sh
INTERBOX_PUBLIC_URL=https://interbox.internal.example
INTERBOX_AUTH_ISSUER=https://aidbox.example.com      # exactly what step 1 printed
INTERBOX_AUTH_CLIENT_ID=interbox-dashboard
INTERBOX_AUTH_CLIENT_SECRET=<the secret from step 2>
INTERBOX_AUTH_ALLOWED_SUBJECTS=alice,bob             # Aidbox User ids
INTERBOX_AUTH_ADMIN_ENABLED=false
```

### Worked example: Microsoft Entra ID

**1. Register the application.** In the Entra admin centre, **Identity →
Applications → App registrations → New registration**. Give it a name, choose
**Accounts in this organizational directory only**, and under *Redirect URI*
pick platform **Web** with:

```
https://interbox.internal.example/api/auth/callback
```

The same thing from the command line, if you would rather:

```sh
az ad app create \
  --display-name "Interbox dashboard" \
  --sign-in-audience AzureADMyOrg \
  --web-redirect-uris "https://interbox.internal.example/api/auth/callback"
az ad sp create --id <application (client) id>
```

The portal's *New registration* creates both the application and its service
principal; `az ad app create` creates only the application, which is why the
second command is there.

**2. Add a client secret** — **Certificates & secrets → New client secret**, or
`az ad app credential reset --id <app id>`. Copy it immediately; Entra shows it
once.

**3. Find the object id of each person who may sign in.** **Identity → Users →**
the person **→ Object ID**, or `az ad signed-in-user show --query id -o tsv` for
your own. This is what you allow-list, and step 5 explains why it is not their
email address.

**4. Configure Interbox:**

```sh
INTERBOX_PUBLIC_URL=https://interbox.internal.example
INTERBOX_AUTH_ISSUER=https://login.microsoftonline.com/<tenant id>/v2.0
INTERBOX_AUTH_CLIENT_ID=<application (client) id>
INTERBOX_AUTH_CLIENT_SECRET=<the secret from step 2>
INTERBOX_AUTH_ALLOWED_SUBJECTS=<object id>,<object id>
INTERBOX_AUTH_ADMIN_ENABLED=false
```

The sign-in button reads **Sign in with Microsoft** on its own: the name comes
from the issuer host, and the Entra hosts are known ones. That covers the
commercial cloud, US Government, the operator in China, and B2C and External ID
tenants on `.b2clogin.com` and `.ciamlogin.com`.

**5. Two things about Entra specifically.**

**Use your tenant id in the issuer, never `common` or `organizations`.** Those
multi-tenant endpoints publish a discovery document whose `issuer` is the
literal string `https://login.microsoftonline.com/{tenantid}/v2.0` — a template,
not an issuer. Interbox compares the advertised issuer with the configured one
byte for byte, so it refuses with *"the discovery document names a different
issuer"*. That refusal is doing its job: an issuer that matches every tenant
would let an account in any Entra tenant anywhere sign in to your dashboard,
which is a real attack and not a theoretical one. If you genuinely want more
than one tenant, name each one and run the check per tenant, rather than
delegating the question to Microsoft.

**Allow-list object ids, not email addresses.** Entra does not send
`email_verified`, and Interbox requires that boolean before it will trust an
address, so `INTERBOX_AUTH_ALLOWED_EMAILS` and `_ALLOWED_DOMAINS` will refuse
everyone against Entra. Entra's `email` claim can also carry an unverified
`otherMails` entry, which is exactly why the boolean is required. Subject rules
are matched against both the token's `sub` and its `oid`: `sub` is unique per
application and appears nowhere in the portal, while `oid` is the object id the
portal shows you — so allow-listing what you read off the screen works.

One consequence to know about before you rely on it: the session and the audit
log record `sub`, so if you allow-list an `oid` the audited value will not be
the string you configured. Same person, different identifier.

**6. Admitting people by group.** Entra can carry group membership in the token
and Interbox will match on it, but the default state of a new registration
issues no group claim at all, so a group rule silently admits nobody. Turn it
on with **Token configuration → Add groups claim → Security groups**, or:

```sh
az rest --method patch \
  --url "https://graph.microsoft.com/v1.0/applications/<app OBJECT id>" \
  --body '{"groupMembershipClaims":"SecurityGroup"}'
```

That URL takes the application's **object id**, not its application (client) id;
`az ad app show --id <client id> --query id -o tsv` prints it.

**Entra puts group object ids in the token, not display names.** Measured
against a live tenant: with the claim enabled, a member of one group receives
`"groups": ["<guid>", "<guid>"]`. So the rule is written with ids:

```sh
INTERBOX_AUTH_ALLOWED_GROUPS=11111111-2222-3333-4444-555555555555
```

Read the id from **Identity → Groups →** the group **→ Object ID**, or
`az ad group show --group "<display name>" --query id -o tsv`. A display name in
that variable will never match anything.

That also settles which side of the earlier warning Entra falls on. The caution
about group rules is about providers that emit a name the person signing in
might be able to influence; an Entra object id is assigned by the directory and
is not something a member chooses.

One failure mode to recognise, which is Microsoft's documented behaviour rather
than anything measured here: past roughly two hundred group memberships Entra
stops sending `groups` and sends `_claim_names` and `_claim_sources` instead,
pointing at Graph. Interbox has no group array to match, so it refuses. It fails
closed, which is the right direction, but it looks exactly like a broken
configuration — so if some people can sign in and others cannot, count their
groups before re-reading your config.

#### Use `_SUBJECTS`, not `_EMAILS` or `_DOMAINS`

Aidbox's id_token carries `sub`, `iss`, `aud`, `iat`, `exp`, `jti`, `nonce`
and `email` — but **not** `email_verified`, and Interbox requires that boolean
before it will trust an address. So an email or domain rule against Aidbox
admits nobody, and the refusal looks like a rejected account rather than a
configuration mistake. Match on the subject, which is the Aidbox `User` id.

Adding a person is then: create their `User` in Aidbox, add the id to
`INTERBOX_AUTH_ALLOWED_SUBJECTS`, restart. Removing one is the reverse, and
`revoke-all` ends any session they already hold.

#### When Aidbox itself signs people in with Google, Okta or Entra

Aidbox can delegate to an external provider of its own — an `IdentityProvider`
resource, which puts an extra button on the Aidbox login page. That changes
nothing about how you configure Interbox, and it is worth being clear why:

```text
Interbox  →  Aidbox  →  Google (or Okta, Entra, another Aidbox…)
          ↑ the issuer         ↑ Aidbox's business, invisible to Interbox
```

Interbox's issuer stays **Aidbox**. It never learns which upstream provider
authenticated anyone, never sees those credentials, and needs no configuration
for them. `INTERBOX_AUTH_ISSUER`, `_CLIENT_ID` and `_CLIENT_SECRET` are exactly
as above. Registering the external provider — including its redirect URI, which
is `<your aidbox>/auth/callback/<IdentityProvider id>` — is done in Aidbox, not
here.

**What does change is the subject.** A person who signs in through an external
provider gets an Aidbox `User` whose id is a **UUID**, not their email and not
a name you chose:

```sh
INTERBOX_AUTH_ALLOWED_SUBJECTS=a0ffc845-77f9-4ae5-af8b-cd6a4f04d18a,7c1e...
```

That is the `sub` Aidbox puts in the id_token. A subject rule is matched
against the token's `sub` **and** against `oid`, because Microsoft Entra
identifies a directory object by `oid` and an operator reading it out of the
Entra portal would otherwise have nothing that works. Aidbox issues no `oid`, so
against Aidbox the rule is `sub` and nothing else.

One consequence of that worth knowing: the audit line and the session record the
token's `sub` either way, so if you allow-list an Entra `oid` you will not see
that value in any log. Match on `sub` if you want the log to name the rule that
admitted someone.

Two more consequences worth planning for:

- **The subject only exists after the person has signed in once.** So the first
  attempt is *meant* to fail. Let them sign in, watch it be refused, and read
  the subject out of the audit line:

  ```json
  {"audit":"sign-in-refused","method":"oidc","issuer":"https://aidbox.example.com",
   "subject":"a0ffc845-77f9-4ae5-af8b-cd6a4f04d18a","reason":"not admitted"}
  ```

  Add that value to `INTERBOX_AUTH_ALLOWED_SUBJECTS`, restart, and they are in.
  A `403` saying "this account may not use this instance" is this step, not a
  broken configuration — it means authentication worked and no rule matched.

  You can also list them from Aidbox directly:

  ```sh
  curl -s -u <admin> 'https://aidbox.example.com/User?_elements=id,email' | jq '.entry[].resource'
  ```

- **Accounts are created by signing in, not beforehand.** Aidbox provisions the
  `User` on the person's first successful sign-in through the provider — it has
  no password, and it records an `identifier` for each upstream system that has
  vouched for them. Whether a second route later links to that same `User` or
  makes another one is Aidbox's business and worth confirming for your setup
  before you assume either; if it makes another, that is a second subject and
  both need listing.

Email and domain rules still do not work here, for the same reason as before:
the claim Interbox needs, `email_verified`, is not in Aidbox's id_token however
the person reached it. The upstream provider may verify addresses thoroughly;
that fact does not survive the hop.

#### Two failures particular to Aidbox

| what you see | what it is |
|---|---|
| Sign-in stops on an Aidbox "do you allow this application" page | the `Client` is missing `first_party: true` |
| `403` "this account may not use this instance" after a successful Aidbox login | the `User` id is not in `INTERBOX_AUTH_ALLOWED_SUBJECTS` — or you used `_EMAILS`/`_DOMAINS`, which cannot work here. If they signed in through an external provider, this is expected on the first attempt; take the subject from the audit line |
| No button for Google (or Okta, Entra) on the Aidbox login page | Aidbox has no `IdentityProvider` for it. That is Aidbox configuration, not Interbox's |

Everything else is in [When a sign-in fails](#when-a-sign-in-fails) below.

### What a session is

A 256-bit random token in a `__Host-` cookie: HttpOnly, Secure, SameSite=Lax, no
`Domain`. Only its hash is stored, so a leaked database row is not a usable
credential. Sessions last **12 hours absolutely** — no idle extension, no
renewal.

Signing out ends one session. Ending *every* session is a second capability, and
the dashboard does not put a button on it: it would sit beside **Sign out** and do
something far larger, since it signs out every operator including whoever pressed
it. It is a request you make yourself, with the cookie your browser already holds:

```sh
curl -X POST https://interbox.internal.example/api/auth/sessions/revoke-all \
  -H 'Content-Type: application/json' \
  -H 'Sec-Fetch-Site: same-origin' \
  -b '__Host-interbox_session=<your session cookie>' \
  -d '{}'
```

Both headers are load-bearing. A state-changing request carrying the session
cookie has to declare `application/json` and has to say it is same-origin, or it
is refused with `403` — the same two rules that stop another site's page using
your logged-in browser. The cookie is `HttpOnly`, so you cannot read it with
`document.cookie`; take it from your browser's storage inspector.

It ends every session, every assistant conversation, and every conversation's
credential — yours among them, so it signs you out too. That is what makes
rotating a leaked password meaningful. Restarting
Interbox also ends every administrator session, because that password is only
ever held in memory — so changing it and restarting provably evicts anyone using
the old one.

Both also end the assistant conversations the session opened, and that is not
housekeeping. An assistant transcript holds the message content it was asked
about, and it lives on the container filesystem rather than in the database, so
it is outside whatever retention the database has.

Be precise about what ending a session does to it. Interbox stops the agent
process, drops the conversation from memory, and forgets the identifier it would
have used to resume it — so the conversation cannot be continued, by anyone,
without starting a new one. It does **not** delete what the agent itself wrote
under its own home directory. Those files are inside the container and share its
lifetime, so a container that is replaced on each deploy discards them; one with
a persistent volume mounted over that path does not. If you have a retention
obligation that reaches transcripts, treat that as a filesystem question and not
as something signing out has already handled.

### Browser support

Interbox decides whether a request came from its own pages using the
`Sec-Fetch-Site` header, and refuses a **cookie-carrying** request that does not
send it. That needs **Chrome 76+, Firefox 90+, or Safari 16.4+**.

An older browser fails in an unhelpful shape, so it is worth recognising: the
sign-in itself succeeds — it carries no cookie yet — and then every request
afterwards is refused with `403`. A dashboard that lets you in and then shows
nothing but errors is almost always this.

### Turning the password account off

```sh
INTERBOX_AUTH_ADMIN_ENABLED=false
```

Leaves single sign-on as the only way in. Unlike the switch that turns the whole
login off, an unrecognised value here is refused rather than assumed.

**Do this in any deployment that serves a workspace UI.** Workspace-authored
pages are served from Interbox's own origin at `/workspace-ui/*`, so a page in
that workspace can render a convincing copy of the sign-in form on the address
operators trust, and collect the password. Nothing Interbox can do stops that
while a password exists to be typed. With OIDC only, there is nothing to phish
on this origin: the credential is entered at the identity provider.

### Attribution

The password account is one shared identity called `admin`. The log will say an
authenticated operator did something, not **which** operator. If you need to
know who, that is single sign-on — there is no other way to get it.

The dashboard shows who is signed in beside the sign-out control, and
`/api/auth/status` returns the same thing: a display name, the subject, the
issuer that vouched for it, and when the session began.

The display name is whatever the provider is willing to say. Interbox takes the
first of `name`, `preferred_username` and `email` that the verified ID token
carries. If it carries none of them and the provider publishes a
`userinfo_endpoint`, Interbox asks that endpoint once during the sign-in, while
the access token is still in hand, and keeps the name from the answer — an
answer about a different subject is refused. Providers differ here: some put a
name in the token, others hold it back until asked, so a deployment may see a
name, an email address, or neither.

It is a label and nothing else. Identity is still issuer plus subject: that is
what the allow-rules judge, what the session is keyed by and what the log
records. Where nothing named the account — the built-in `admin` among them —
the control falls back to the subject, shortening a long one with the full
value in its tooltip.

## How signing in works

Worth reading once, because every failure below maps onto a step of it.

**Discovery, on the first sign-in.** Interbox fetches
`<issuer>/.well-known/openid-configuration`, refusing redirects, and requires
the document's own `issuer` to equal the one you configured. It keeps the
result for the life of the process, so a provider that is later compromised
cannot swap the token endpoint underneath a running instance. Changing a
provider's endpoints means restarting Interbox.

**`GET /api/auth/start`.** Interbox mints four values: a `state`, a `nonce`, a
PKCE verifier, and a random cookie value. The first three go into a row in its
own database, keyed by the *hash* of that cookie and living ten minutes; the
cookie goes to the browser. Then it redirects to the provider with
`code_challenge_method=S256` — always S256, never read back from discovery,
because a provider that omits the field would otherwise silently downgrade the
exchange to `plain`.

**At the provider.** The person authenticates however that provider works —
password, MFA, a corporate session they already have. Interbox is not involved
and never sees the credential.

**`GET /api/auth/callback`.** The provider sends the browser back with a code.
In order, Interbox:

1. reads the login cookie and **deletes the matching row in the same
   statement**, so a code can never be used twice;
2. checks `state` against that row — and the `iss` response parameter too, when
   the provider advertises support for it;
3. exchanges the code, sending the stored PKCE verifier and the one configured
   `redirect_uri`;
4. verifies the id_token against the provider's published keys with a pinned
   algorithm list, requiring `exp`, `iat` and `sub`;
5. checks `nonce`, `aud`, and `azp` when the token names several audiences;
6. applies your allow-rules;
7. mints a session and sends the browser to wherever the sign-in started.

Requiring **the cookie in addition to `state`** is the step that matters most.
Without it, an attacker could start a login with their own identity and drive
your browser to the callback, seating you inside *their* session — on a
dashboard that reaches PHI and a shell agent.

**What is never stored.** The provider's access and refresh tokens are
discarded. Interbox makes exactly one call with the access token — the userinfo
request above, during the sign-in that issued it, and only when the ID token
named nobody — and never keeps it afterwards, because a stored token is one the
SQL console and the assistant can reach.

**What identifies you** is still issuer plus subject: that is what the
allow-rules judge, what the session row is keyed by, and what the audit log
records. Never the email address, because addresses get reassigned to new
people. A display name is recorded alongside it and may well *be* an email, but
nothing decides anything on it — it exists to put a person's name in a header
instead of an opaque identifier.

```text
browser → /api/auth/start → provider login → /api/auth/callback → dashboard
             ↑ sets a 10-minute cookie          ↑ that cookie, plus state,
               and stores state/nonce/verifier    plus a verified token
```

### When a sign-in fails

| what you see | what it usually is |
|---|---|
| Dashboard parked; `/api/auth/status` names `INTERBOX_AUTH_ALLOWED_EMAILS` | an issuer is set with no allow-rule. Add one |
| `503` "the identity provider could not be reached" | the issuer does not match what the provider publishes, the Interbox process cannot reach it, or that URL answered with a redirect |
| The provider rejects the request before showing a login | its registered redirect URI is not `<INTERBOX_PUBLIC_URL>/api/auth/callback`, exactly |
| `400` "this sign-in did not start here" | the login cookie is missing, older than ten minutes, or already used. Start again from the sign-in page |
| `400` "this sign-in could not be completed" | `state`, the code exchange, or token verification failed. The server log names which |
| `403` "this account may not use this instance" | authentication worked; no allow-rule matches that identity. The log records the subject that tried |
| Sign-in succeeds, then every panel shows errors | the browser is older than the `Sec-Fetch-Site` floor — see Browser support above |

Every one of these is recorded in the server log with a reason. The browser is
deliberately told less than the log: a sign-in page that explains precisely
which check failed is a sign-in page that helps an attacker.

## Required in every deployment

`INTERBOX_PUBLIC_URL` is the browser-facing origin — scheme, host and port, no
path:

```sh
INTERBOX_PUBLIC_URL=https://interbox.internal.example
```

It is required **whether or not the login is on**, because it is not only an
authentication setting: it is the origin Interbox will answer for. A request
arriving with any other `Host` is refused, which is what stops a DNS-rebinding
page in someone's browser from talking to a port-forwarded dashboard. It must be
`https` unless it is loopback, since a `Secure` cookie cannot travel over plain
HTTP.

## When it is misconfigured, ingestion keeps running

A missing password or a malformed variable does **not** stop the process. The
dashboard and its API answer `503` and say which variable is at fault; the engine
keeps consuming and delivering messages throughout. This matters because the
container runs both: exiting on a dashboard variable would take the MLLP listener
with it and refuse a hospital's feed at the TCP level.

`/api/health` keeps answering so the container is not killed, and
`/api/auth/status` names the variables so an operator can see what to fix.
`/api/ready` answers `503` while parked and `200` once the login is usable.

> `/api/ready` is a **diagnostic**, not a readiness probe. Do not wire it to a
> `readinessProbe` on a pod whose Service also carries MLLP: a parked dashboard
> would drop that pod from the Service and refuse the feed at the TCP level,
> which is the outcome the parking behaviour exists to avoid.

## Turning it off

```sh
INTERBOX_AUTH_ENABLED=false
```

This turns off **the session requirement and nothing else**. The Host allowlist
and the cross-site rules stay on, because the threats they cover — DNS rebinding
against a port-forward, a cross-site write from a page the operator happens to be
visiting — do not need a cookie to work.

Only `false` and `0` disable it. Anything unrecognised leaves the login **on**: a
typo in this variable must not quietly unlock a dashboard.

## What reaches the API without a browser

Two things, and no third: a signed-in session, and a **service grant** — the
credential the dashboard mints for one assistant conversation. There is no
deployment-wide bearer token to configure, and nothing you can set that creates
one. Every credential this deployment accepts therefore expires, and every one of
them can be revoked — see [What a session is](#what-a-session-is).

### The assistant carries a grant

The assistant is an agent with a shell, and it reads message content — so a
message crafted by whoever sends you clinical data can try to instruct it. When a
conversation starts, it is given a credential of its own: minted for that
conversation, tied to the dashboard session that opened it, and valid for **one
hour**.

It can be taken away, which is the point. Signing out revokes the grants of the
conversations that session started; [revoking every session](#what-a-session-is)
revokes every one of them. Both take effect immediately, and neither needs a
restart or a change to the deployment's configuration.

What a grant reaches is not nothing. Read access to messages and their FHIR
output — that is PHI — plus three writes: `POST /api/repository/pull` (updates the
workspace checkout and reloads the engine), `POST /api/concept-maps/:map/entries`
(rewrites clinical code translation) and `POST /api/messages/retry` and `/defer`
(re-queues messages, including ones already delivered).

What it reaches is eleven route shapes, matched by method and path, and nothing
outside them: no SQL console, no workspace actions, no repository file writes and
no assistant route.

What this does **not** do is stop a crafted message from reaching the agent, or
stop the agent from acting within the routes it can already reach. It bounds what
a stolen credential is worth and how long it stays worth it. If you suspect a
message drove the assistant somewhere it should not have gone,
[revoke every session](#what-a-session-is): that ends every conversation's
credential immediately.

### The command-line tool

`interbox` is not a browser, so a grant is the only thing that gets it in — which
means it works from inside the dashboard assistant, where that credential is
already in the environment under `INTERBOX_SERVICE_TOKEN`. Setting that variable
by hand to a value of your own does not work: the API knows no such credential and
answers `401`. The tool still refuses to send what it has to a plain-`http`
`INTERBOX_API_URL` that is not loopback, since that would put a live credential on
the network in cleartext.

Every request made with a grant is written to the log — the method, the path, and
the session the grant belongs to — so you can tell afterwards what was read.

## The database role Interbox connects as

The SQL console is read-only: every query runs inside a read-only transaction, so
nothing it does can write to your tables. That phrase covers less than it sounds
like. Read-only stops writes; reading a file off the database *host* is a read. If
`DATABASE_URL` names a superuser — or any role belonging to `pg_read_server_files`
— then `pg_read_file('/etc/passwd')` answers inside that read-only transaction, and
the console reaches the machine rather than the data.

Only signed-in operators can ask (the assistant's credential is refused this route),
so this is not a hole an anonymous caller walks through. It is a reason to give
Interbox a role that cannot do it in the first place.

**Interbox needs ownership of its own database, and nothing above that.** It creates
its schemas, tables, partitions and indexes on boot, and it installs two extensions,
`pg_trgm` and `btree_gist`. Both are *trusted* extensions, so the database owner can
install them without being a superuser:

```sql
CREATE ROLE interbox LOGIN PASSWORD 'a-strong-password';
CREATE DATABASE interbox OWNER interbox;
```

Point `DATABASE_URL` at that role rather than at the cluster's administrative one.

Two things to check on a managed service, where the "admin" account you are given is
often more than an owner:

```sql
SELECT current_setting('is_superuser');            -- expect: off
SELECT pg_read_file('/etc/hostname');              -- expect: permission denied
```

If the second one answers, revoke the membership that allows it:

```sql
REVOKE pg_read_server_files FROM interbox;
REVOKE pg_execute_server_program FROM interbox;
```

Some managed services also require extensions to be allowlisted before the owner can
create them — see [Deployment gotchas worth knowing](#deployment-gotchas-worth-knowing).

## Additional layers

A login on the application does not make the application public-facing. For a
real deployment, put it behind an internal ingress with TLS, and — if your
organisation already runs one — a login gate in front as well. The rest of this
page is that setup.

## Writes are same-origin only

Every non-GET `/api/…` request is checked before it reaches a route. A browser
`Origin` header naming anything but this deployment's own host is refused with 403,
and so is a declared content type other than `application/json`. That stops a page on
another site from using a logged-in operator's browser to commit to your workspace,
switch its branch, or run a workspace action. `localhost` origins get no special
treatment on a remote deployment: they are accepted only when the deployment itself
is served from `localhost`, so a page running on an operator's own machine cannot
write to a remote instance through their browser.

`INTERBOX_ALLOWED_ORIGINS` — a comma-separated list — adds origins the guard treats as
this deployment's own, which satisfies the `Origin` check for them.

It does **not** make a dashboard on a different host work, and it is worth being blunt
about that rather than letting the name suggest otherwise. The session cookie is
`SameSite=Lax`, so it rides top-level navigations and nothing else: a cross-site
`fetch` carries no cookie, and every gated route answers `401` however the origin is
listed. A cross-site state-changing request is refused separately, on `Sec-Fetch-Site`.
So with the login on, listing an origin buys a browser exactly the routes that need no
session — `/api/health`, `/api/ready`, and `/api/auth/status`.

Serve the dashboard from the origin that serves the API — which is what the image does
— or put both behind one hostname on a reverse proxy. The variable is for a second
front end that calls those public routes, not a way to split the dashboard off.

Reading is narrower than writing. A cross-origin **read** is granted only to
`INTERBOX_PUBLIC_URL` and to anything named in `INTERBOX_ALLOWED_ORIGINS`, and to
nothing else — a page on another port of the same machine is refused even when
Interbox is served from `localhost`. Development does not need that grant,
because the dashboard's dev server proxies `/api` rather than calling it across
origins, so reflecting every local port would widen what any other program on the
machine can read for no benefit.

This is not a substitute for the login gate. A request carrying no `Origin` at all is
not a browser and passes the check, so a script that can reach the port can still call
the API. The origin check is what carries the protection: a scripted client may send
`Content-Type: application/json` or no content type at all — only a different declared
type is refused.

Request bodies are capped at 8 MB, and at 4 MB on the `/api/repository/…` routes.

### The pieces

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

### How a request flows through such a proxy

```text
Browser → ingress (terminates TLS)
        → ingress asks oauth2-proxy "is this user logged in?"
            → no session → 302 redirect to the identity provider's login
            → user logs in → back to oauth2-proxy → sets a session cookie
        → ingress now allows the request → Interbox dashboard
```

### The chart values that wire it

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

### TLS: choosing a certificate issuer

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

### The proxy's own identity provider

oauth2-proxy needs an OIDC provider. In production that's your IdP — e.g. **Entra
ID (Azure AD)**: register an application, set its redirect URI to
`https://<host>/oauth2/callback`, and give oauth2-proxy the issuer URL, client ID,
and client secret. Any OIDC provider works the same way.

Interbox has no built-in RBAC, so **who may sign in is the whole access
control** — whether you scope it at Interbox's own allow-rules, at the identity
provider, or at a proxy in front. Interbox records every sign-in, refusal,
sign-out and revocation as a structured log line; a proxy in front will have its
own log, and the two are worth keeping together.

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
