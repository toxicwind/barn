#!/usr/bin/env bash
# kappa-serve wrapper — auto-load kappa's secrets from the secretsmith keyring
# into the kappa serve env, then exec kappa serve.
#
# This is the estate's drop-in secret loader (Rule 3: "Inject keys into any
# process with `secretsmith env`"). `secretsmith env --app kappa` emits
# `NAME='value'` export lines for every keyring item tagged `service=kappa`,
# so kappa's secrets are deterministically injected — no hand-rolled grep/cut.
#
# Auth is optional for kappa serve (enforced only when the password is
# non-empty), so a missing secret does NOT block startup on the loopback bind —
# but we surface it loudly instead of silently serving unsecured.
set -u

_sm_bin=/home/toxic/.local/bin/secretsmith

if [ -x "$_sm_bin" ]; then
  # Load only kappa's secrets into the exported environment (opt-in export lines).
  _env="$( "$_sm_bin" env --app kappa 2>/dev/null )"
  _exit=$?
  if [ "$_exit" -eq 0 ]; then
    set -a
    # shellcheck disable=SC2163
    eval "$_env"
    set +a
  else
    printf 'kappa-serve: secretsmith env --app kappa failed (exit %s); continuing without keyring secrets.\n' "$_exit" >&2
  fi
else
  echo "kappa-serve: $_sm_bin missing; continuing without keyring secrets." >&2
fi

unset _env _exit _sm_bin

exec /home/toxic/.local/bin/kappa serve --hostname 127.0.0.1 --port "${KAPPA_SERVER_PORT:-25159}"