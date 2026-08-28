# Dashboard binary Runtime example

This example commits only Go source and a manifest. Build both static Linux
targets and package the normal HTTP bundle with:

```sh
./build-bundle.sh
```

The build runs `go build` inside `golang:1.22-alpine`; Go is not required on
the host. Docker is required for this optional live-test fixture. To package a
variant whose declared entrypoint arguments make it exit with status 7:

```sh
./build-bundle.sh exit7 dashboard-exit7.appliance.zip
```

Generated `.appliance.zip` files are ignored. The build binaries live only in
a temporary directory and are removed when packaging finishes.
