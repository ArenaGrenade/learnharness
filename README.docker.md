# Local Docker deployment on Mikoshi

Run this from any directory after editing the Documents checkout:

```sh
/mnt/dataset/homelab/learnharness/update-local.sh
```

The command builds the current local working tree, tests sandboxed Chromium,
then recreates the container. Failed builds or browser checks stop deployment.
There is no Git pull, CI deployment or automatic update.

Application data and provider credentials are excluded from the image build.
Persistent state is mounted separately at /appdata. Replacing the image/container
does not replace those host files; application migrations may change them.
Existing data has not yet been copied or migrated into this deployment.

Deployment is currently isolated and gated on browser sandbox/network checks.
See /mnt/dataset/homelab/learnharness/README.md for current status.

This deployment sets LH_AUTH_MODE=cloudflare-access to omit the app passphrase.
Cloudflare Access is the authentication boundary; connector JWT validation and
origin network isolation are required. CSRF checks remain active. Unset this
variable to restore the default passphrase/session requirement. Do not enable
this mode on an origin with public/LAN ports or untrusted peer containers.
