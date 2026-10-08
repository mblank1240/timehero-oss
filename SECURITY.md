# Security

TimeHero holds staff records, leave and pay data, and controls who can sign
in. Please report vulnerabilities privately.

## Reporting

Use GitHub's **private vulnerability reporting**: the **Security** tab of this
repository → **Report a vulnerability**. Please include what an attacker can
do, the steps to reproduce, and the version or commit.

Please do not open a public issue for a vulnerability, and give a fix time to
ship before disclosing. You'll get an acknowledgement within a week.

## Supported versions

Only the latest commit on `main` is supported. Self-hosted installs should
upgrade to it to receive fixes.

## Deployment notes

- `DEV_AUTH_BYPASS` must never be set in production; the app refuses to start
  if it is.
- Keep `AUTH_SECRET` and `JOBS_SECRET` secret, and rotate them if they leak
  (`docs/RUNBOOK.md`).
- Serve TimeHero only over HTTPS.
