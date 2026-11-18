# Web and Docker deployment

Build the app with `python3 deploy/docker/build.py --build-root /path/on/build-disk
--image homelab-learnharness:local` (arguments on one command line). Dependencies,
core plugins and standalone assets are built inside Docker. Source allowlisting
excludes the live profile, credentials and environment files. Large intermediates
use the selected disk rather than Docker layers. Node and base images are pinned.

Build the two execution images from the repo root:

```sh
docker build -t homelab-learnharness-execution:local -f deploy/docker/runner/Dockerfile .
docker build -t homelab-learnharness-execution-broker:local -f deploy/docker/runner/Broker.Dockerfile .
```

Use `compose.yaml` with private environment configuration: `LH_APPDATA`,
`LH_ALLOWED_HOSTS`, `DOCKER_GID` (socket group), and a random `EXECUTION_TOKEN`
of at least 32 characters. Optional image variables select validated candidate
or rollback tags. `LH_BROWSER_SECCOMP` can select an absolute policy path.
Keep the env file outside Git, mode 0600. The existing edge/search networks and
SearXNG service must exist. Public access requires the configured authentication
front door when `LH_AUTH_MODE=cloudflare-access`; passphrase mode instead uses
the app's existing login setup. Do not expose the internal broker publicly.

The app has no Docker socket. Only the narrow private broker can create fixed
execution jobs. Each job is non-root, networkless, read-only except bounded
scratch storage, has no app/profile/credential mounts, drops capabilities, and
limits CPU, RAM, processes, time and output. CUDA jobs alone request one GPU.
Expired jobs are reaped after broker restart. Docker and the GPU driver remain
part of this single-user host's trusted boundary.

`plugins/coding-questions/runner/languages.json` declares Python, CUDA, C++, Rust.
Edit this registry and the runner Dockerfile together when changing languages.
The capability API checks installed compilers and actual GPU execution; the UI
and agent receive readiness and versions. Only Python test drivers are accepted;
they read `answer.txt` and may compile the configured compiled languages. No
runtime or package downloads occur during execution. An unavailable runner never
falls back to local app execution. The plugin must be enabled in app settings.

Run `python3 deploy/docker/runner/smoke.py BROKER_CONTAINER` to validate real
submissions and isolation. `node deploy/docker/smoke.mjs` runs inside an app
container with disposable state, checking routes, access policy and Chromium.

Before replacement, stop the app briefly for a consistent profile backup and
preserve the current app/guard/broker image tags and private Compose/env files.
Recreate the stack using the validated image tags and verify health, saved
sessions, provider status, plugins and runner. To roll back, stop the app and
restore the saved Compose/image references and profile backup together; do not
mix a pre-upgrade image with data that the new app has modified.

`python3 deploy/docker/update.py --env-file /private/deployment.env --state-dir
/private/deployment --build-root /build-disk` builds before stopping the app,
then snapshots images/configuration and the stopped profile before replacement.
Use `--skip-build` only for already validated image tags. A failed replacement
retains the snapshot for rollback; inspect the failure before restoring it.

For responsive UI validation, copy `smoke-mobile.mjs` into a disposable candidate
container and run it with `LH_DATA_DIR` under `/tmp`. It refuses live profiles.
The gate exercises 320/390/430px phones, 740px landscape and 1280px desktop,
including touch scrolling, navigation, all settings sections, long labels,
question/options scrolling and a reduced visual viewport. `LH_EVIDENCE` selects
the screenshot/result directory. It injects display-only account/model fixtures,
never sends model requests, and removes its synthetic chat afterward.
