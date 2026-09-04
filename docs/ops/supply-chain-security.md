# Supply Chain Security

Interbox ships as one public image, `healthsamurai/interbox`, so you can verify what
you run.

## Signed container images

Images are signed with [Cosign](https://docs.sigstore.dev/), keyless: there is no
public key to download — you check the identity of the workflow that built the image:

```bash
cosign verify \
  --certificate-identity "https://github.com/HealthSamurai/interbox/.github/workflows/publish.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  healthsamurai/interbox:latest
```

A non-zero exit means the image was not produced by our release pipeline: do not
deploy it. Releases older than this page are unsigned and fail this check.

The scan result is attested alongside the signature (`--type vuln`) and re-attested
nightly for the current release and `edge`. Nightly re-attestations carry the `image-rescan.yml` identity, not `publish.yml`; to
read when the image was last scanned:

```bash
cosign verify-attestation --type vuln \
  --certificate-identity "https://github.com/HealthSamurai/interbox/.github/workflows/image-rescan.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  healthsamurai/interbox:latest | jq -rs 'map(.payload | @base64d | fromjson | .predicate.metadata.scanFinishedOn) | max'
```

Verifying `--type vuln` with the `publish.yml` identity is also valid, but returns
only the build-time attestation — its `scanFinishedOn` is the build date.

## Vulnerability scanning

Health Samurai scans Interbox images with [Trivy](https://trivy.dev) on every pull
request, on the release build before any version tag is applied, and nightly against
the already-published tags. A fixable CRITICAL or HIGH fails the build, and so does a
leaked credential — the same passes scan the image for secrets.

Findings with no available fix are reported rather than blocked. There are no other
standing exemptions; any exception would carry a written reason and an expiry date.
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
older than this page answer `{}` here — they carry provenance but no SBOM.

The same bill of materials in CycloneDX, signature-verified:

```bash
cosign verify-attestation --type cyclonedx \
  --certificate-identity "https://github.com/HealthSamurai/interbox/.github/workflows/publish.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  healthsamurai/interbox:latest | jq -r '.payload' | base64 -d | jq '.predicate' > interbox-sbom.cdx.json
```

The verification verdict prints to the terminal; the file gets the full CycloneDX
document — around 1.5k components — ready for your vulnerability-management tooling. The same
bill of materials in CycloneDX is the `--type cyclonedx` attestation above; the
verify-attestation command prints it.

## Pinning a digest

Tags move; digests do not. Resolve one and deploy that, so you choose when to take a
new build and can scan the exact bytes you run:

```bash
docker buildx imagetools inspect healthsamurai/interbox:latest --format '{{ json .Manifest }}' | jq -r .digest
```

## Remediation

Health Samurai triages and remediates reported vulnerabilities on a schedule driven
by CVSS v3.1 severity:

| Severity | CVSS v3.1 | Triage | Remediation |
|---|---|---|---|
| Critical | 9.0–10.0 | ≤ 24 hours | ≤ 7 days |
| High | 7.0–8.9 | ≤ 3 business days | ≤ 30 days |
| Medium | 4.0–6.9 | ≤ 7 days | ≤ 90 days |
| Low | 0.1–3.9 | ≤ 30 days | ≤ 180 days |

Vulnerabilities under active exploitation, or involving exposure of protected health
information (PHI), are handled as security incidents rather than on the tiers above.

## Reporting a security issue

If you discover a security vulnerability in Interbox, report it to
security@health-samurai.io. Do not disclose the issue publicly until it has been
resolved.
