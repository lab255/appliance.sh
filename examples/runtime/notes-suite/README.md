# Notes Suite compound Runtime example

This source-only example packages two OCI services into one compound bundle:
`api` starts first and must pass `/healthz`; `web` depends on it and exposes the
only host port. Both leaves share one Runtime VM app principal and loopback.

Build the current host architecture with Docker Buildx, then package it:

```sh
./build-bundle.sh
```

The generated OCI archives, executable, staging tree, and bundle exist only
during the build or in the ignored output zip. No binaries are committed.
