#!/bin/sh
# install-hook.sh -- install push-guard into the CURRENT repository's hooks.
#
# Run from inside the repository you mean to guard:
#
#   cd /path/to/repo && install-hook.sh
#
# Why this is a script and not a one-liner: the obvious spelling is
#
#   install -Dm755 /home/toxic/bin/pre-push "$(git rev-parse --git-dir)/hooks/pre-push"
#
# and outside a repository `git rev-parse --git-dir` prints its error to
# stderr, writes NOTHING to stdout, and the -D flag then happily creates the
# parent directories. That is how a husk `.git/` with a hooks/ directory and
# no HEAD, no objects and no refs appeared at /home/toxic/.git: it looked
# like a repository to every tool that checks "is there a .git?", while git
# itself correctly reported "fatal: not a git repository". A policy adapter
# adopted it as the project root and walked 768GB. So the guard is now:
# resolve the absolute git dir, and refuse if there is not one.
#
# Bypass the guard on a push: PUSH_GUARD_SKIP=1 git push   (loud, never silent)

set -eu

if ! command -v git >/dev/null 2>&1; then
	echo "install-hook.sh: git is not on PATH" >&2
	exit 1
fi

# --absolute-git-dir prints an absolute path and, unlike --git-dir, prints
# nothing at all when discovery fails. The exit status is the real signal.
if ! git_dir=$(git rev-parse --absolute-git-dir 2>/dev/null) || [ -z "$git_dir" ]; then
	echo "install-hook.sh: not inside a git repository (cwd: $(pwd))" >&2
	echo "  cd into the repository you want to guard, then re-run." >&2
	exit 1
fi

# A directory that exists but is not a usable repository is exactly the husk
# this script exists to stop installing into. Refuse rather than deepen it.
if [ ! -e "$git_dir/HEAD" ] || [ ! -d "$git_dir/objects" ]; then
	echo "install-hook.sh: $git_dir is not a usable git directory" >&2
	echo "  (missing HEAD or objects/ -- this is a stub, not a repository)" >&2
	exit 1
fi

toplevel=$(git rev-parse --show-toplevel)
install -Dm755 /home/toxic/bin/pre-push "$git_dir/hooks/pre-push"
echo "installed push-guard into $toplevel"
echo "  $git_dir/hooks/pre-push"
echo "  bypass: PUSH_GUARD_SKIP=1 git push"
