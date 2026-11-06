# Supply Chain Security

Interbox ships as one public image, `healthsamurai/interbox`, so you can verify what
you run.

## Signed container images

Health Samurai signs Interbox images with [Cosign](https://docs.sigstore.dev/).

### Release images

Health Samurai's CI key signs every release image, under a version tag or `latest`. Earlier
releases carry a keyless signature from the release pipeline that built them, and for those
you check that workflow's identity instead. This command accepts either:

```bash
cosign verify --key https://storage.googleapis.com/interbox-signing-keys/cosign.pub \
  healthsamurai/interbox:latest \
|| cosign verify \
  --certificate-identity "https://github.com/HealthSamurai/interbox/.github/workflows/publish.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  healthsamurai/interbox:latest
```

A non-zero exit means Health Samurai did not build the image: do not deploy it. Releases
older than this page are unsigned and fail both checks.

### Development images

Our CI builds a development image, `edge` or `main-<sha>`, from main between releases and
signs it with the same key, so the same command verifies it with the tag changed.

A signature says Health Samurai's CI built the image. It does not tell a release
image from a development image, so to run releases only, deploy a version tag pinned to its
digest (see [Pinning a digest](#pinning-a-digest)). An admission policy lists the key and the
earlier release pipeline's identity as alternatives, and either one is enough.

### The CI key

A cloud key management service holds the CI key, and the private half never leaves that
service. Instead of fetching the public half from the URL on every check, you can pin it:
save the block below as `cosign.pub` and pass `--key cosign.pub`.

```text
-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEfTexAgXJFeZj1C4g/HQ+jpLEypQX
X5srPnG5tAlaERJaydllk9ZZ1DEEK7uo4remUfsr0PR6P4NABNmqlywMbg==
-----END PUBLIC KEY-----
```

We replace the key only if it is compromised, and announce the new one in the release notes.
If you pinned the old key, replace your copy then.

### Scan attestations

Every signed image also carries its Trivy scan result as an attestation (`--type vuln`),
made at build time. Each night we scan the current release image and `edge` again and
attest the result with the CI key. That nightly attestation tells you when an image was
last scanned:

```bash
cosign verify-attestation --type vuln \
  --key https://storage.googleapis.com/interbox-signing-keys/cosign.pub \
  healthsamurai/interbox:latest | jq -rs 'map(.payload | @base64d | fromjson | .predicate.metadata.scanFinishedOn) | max'
```

Older nightly attestations carry the `image-rescan.yml` workflow identity instead of the
key. An older release also has a build-time attestation under the earlier release
pipeline's identity, whose `scanFinishedOn` is the build date.

## Vulnerability scanning

Health Samurai scans Interbox images with [Trivy](https://trivy.dev) on every pull
request, on the release build before any version tag is applied, and nightly against
the already-published tags. A fixable CRITICAL or HIGH fails the build. So does a leaked
credential: the same passes scan the image for secrets.

A finding with no available fix is reported and does not fail the build. There are no
other standing exemptions. Any exception would carry a written reason and an expiry date.
Questions about a specific finding go to security@health-samurai.io.

Run the same scan against any Interbox image:

```bash
trivy image healthsamurai/interbox:latest
```

## Software Bill of Materials (SBOM)

Each release carries a Software Bill of Materials as an OCI attestation, generated
from the image itself. Use it to audit dependencies and track them against your
vulnerability management process.

```bash
docker buildx imagetools inspect healthsamurai/interbox:latest --format '{{ json .SBOM }}'
```

The result is keyed by platform, each entry an SPDX document. A digest works in place
of the tag, and `.Provenance` in place of `.SBOM` for the build provenance. Releases
older than this page answer `{}` here: they carry provenance but no SBOM.

The same bill of materials in CycloneDX, signature-verified:

```bash
cosign verify-attestation --type cyclonedx \
  --key https://storage.googleapis.com/interbox-signing-keys/cosign.pub \
  healthsamurai/interbox:latest | jq -r '.payload' | base64 -d | jq '.predicate' > interbox-sbom.cdx.json
```

If that finds nothing, the release is an older one: replace `--key …` with the two
`--certificate-…` options from [Release images](#release-images).

The terminal shows whether verification passed, and the file gets the full CycloneDX
document, around 1.5k components, ready for your vulnerability-management tooling.

## Pinning a digest

Tags move; digests do not. Resolve one and deploy that, so you choose when to take a
new build and can scan the exact bytes you run:

```bash
docker buildx imagetools inspect healthsamurai/interbox:latest --format '{{ json .Manifest }}' | jq -r .digest
```

## Remediation

Health Samurai triages and remediates reported vulnerabilities on a schedule set by
CVSS v3.1 severity:

| Severity | CVSS v3.1 | Triage | Remediation |
|---|---|---|---|
| Critical | 9.0–10.0 | ≤ 24 hours | ≤ 7 days |
| High | 7.0–8.9 | ≤ 3 business days | ≤ 30 days |
| Medium | 4.0–6.9 | ≤ 7 days | ≤ 90 days |
| Low | 0.1–3.9 | ≤ 30 days | ≤ 180 days |

A vulnerability under active exploitation, or one that exposes protected health
information (PHI), is handled as a security incident, outside the tiers above.

## Reporting a security issue

If you discover a security vulnerability in Interbox, report it to
security@health-samurai.io. Do not disclose the issue publicly until it has been
resolved.
