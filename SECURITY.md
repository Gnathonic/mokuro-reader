# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's private vulnerability
reporting: open the repository's **Security** tab and choose **Report a
vulnerability** (or go straight to
<https://github.com/Gnathonic/mokuro-reader/security/advisories/new>).

Please do **not** open a public issue, pull request or Discord thread for a
vulnerability before it is fixed.

A useful report includes:

- what an attacker can do, and what they need first (a crafted file to import, a
  malicious cloud folder or server, a link the victim opens, …);
- the steps or a minimal file that reproduces it;
- the version (Settings → About) and the browser you tested on.

The maintainer aims to reply within a week. Once a fix is released, the advisory
is published with credit to you unless you ask otherwise.

## Supported versions

Only the **latest release** receives security fixes. If you run your own copy of
the reader, update to the newest release before reporting.

| Version        | Supported |
| -------------- | --------- |
| Latest release | Yes       |
| Anything older | No        |

## Scope

This repository is the web reader: the app itself, its import pipeline, its
cloud-sync providers and its build and release workflows. Issues in the
upstream services it talks to (Google Drive, OneDrive, MEGA, a WebDAV server,
AniList, AnkiConnect) belong with those projects. Issues in the mokuro-bunko
server belong in [its repository](https://github.com/Gnathonic/mokuro-bunko);
if you are unsure which side a problem is on, report it here.
