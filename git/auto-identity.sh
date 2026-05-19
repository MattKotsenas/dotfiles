#!/usr/bin/env sh
# auto-identity.sh -- GitHub multi-account routing for git.
#
# Two entry points, dispatched on $1:
#   credential <get|store|erase>     git credential helper
#   post-checkout <prev> <new> <flag> git post-checkout hook
#
# Wired up via user.github.gitconfig (see [credential "https://github.com"]
# and [hook "auto-identity"]). Requires gh CLI with each account logged in.
#
# Behavior:
#   - Probes every gh-authenticated github.com account for push permission on
#     <owner>/<repo>. Picks the one qualifying account; fails loudly (no
#     silent tiebreak) when zero or 2+ accounts have push.
#   - Same strict picking for gist.github.com: probes ownership of <id> via
#     `gh api gists/<id>` and requires exactly one matching account.
#   - Sets user.email to <id>+<login>@users.noreply.github.com on first
#     branch checkout (incl. clone), making the chosen account visible.
#   - Credential helper has a fast path that re-reads user.email to skip the
#     API probe on subsequent operations.
#   - No fallback to the "active" gh account anywhere -- if a probe is
#     inconclusive, user.email stays unset (loud commit failure via
#     useConfigOnly=true) and no creds are returned (loud auth failure).
#     For OSS contributions, push to your own fork works because only your
#     personal account has push there.
#
# Do not run `gh auth setup-git` after install -- it injects a parallel
# helper into ~/.gitconfig that overrides this one.

set -u

# ---- gh resolver ----------------------------------------------------------

GH=$(command -v gh 2>/dev/null) || true
if [ -z "$GH" ]; then
	for _p in \
		"/c/Program Files/GitHub CLI/gh.exe" \
		"/c/Program Files (x86)/GitHub CLI/gh.exe" \
		"$HOME/AppData/Local/Programs/GitHub CLI/gh.exe" \
		"/usr/local/bin/gh" \
		"/opt/homebrew/bin/gh"
	do
		if [ -x "$_p" ]; then GH="$_p"; break; fi
	done
fi
[ -n "$GH" ] || { echo "auto-identity: gh CLI not found" >&2; exit 1; }

# ---- pick the gh login with push access to <owner>/<repo> ----------------
# Strict: prints the single qualifying login, or fails with a diagnostic on
# stderr if zero or 2+ accounts have push. Refuses to guess between
# candidates -- if you've got multiple accounts with push to the same repo,
# resolve it explicitly (e.g. set local user.email before the first git op).

pick_login() {
	_owner="$1"
	_repo="$2"
	_logins=$("$GH" auth status --json hosts --jq '.hosts."github.com"[].login' 2>/dev/null) || return 1

	_winners=""
	_count=0
	for _login in $_logins; do
		_token=$("$GH" auth token -h github.com -u "$_login" 2>/dev/null) || continue
		_push=$(GH_TOKEN="$_token" "$GH" api "repos/$_owner/$_repo" --jq .permissions.push 2>/dev/null) || continue
		[ "$_push" = "true" ] || continue
		_winners="$_winners $_login"
		_count=$((_count + 1))
	done

	if [ "$_count" -eq 1 ]; then
		printf '%s\n' "$_winners" | tr -d ' '
		return 0
	fi
	if [ "$_count" -eq 0 ]; then
		echo "auto-identity: no gh account has push access to $_owner/$_repo" >&2
	else
		echo "auto-identity: $_count gh accounts have push access to $_owner/$_repo:$_winners -- refusing to pick" >&2
	fi
	return 1
}

# ---- pick the gh login that owns gist <id> --------------------------------
# Same strict semantics as pick_login. Probes `gh api gists/<id>` per account
# and checks that .owner.login matches the account's own login.

pick_gist_login() {
	_id="$1"
	_logins=$("$GH" auth status --json hosts --jq '.hosts."github.com"[].login' 2>/dev/null) || return 1

	_winners=""
	_count=0
	for _login in $_logins; do
		_token=$("$GH" auth token -h github.com -u "$_login" 2>/dev/null) || continue
		_gist_owner=$(GH_TOKEN="$_token" "$GH" api "gists/$_id" --jq .owner.login 2>/dev/null) || continue
		[ "$_gist_owner" = "$_login" ] || continue
		_winners="$_winners $_login"
		_count=$((_count + 1))
	done

	if [ "$_count" -eq 1 ]; then
		printf '%s\n' "$_winners" | tr -d ' '
		return 0
	fi
	if [ "$_count" -eq 0 ]; then
		echo "auto-identity: no gh account owns gist $_id" >&2
	else
		echo "auto-identity: $_count gh accounts claim ownership of gist $_id:$_winners -- refusing to pick" >&2
	fi
	return 1
}

# ---- credential helper ----------------------------------------------------

cmd_credential() {
	_op="${1-}"
	[ "$_op" = "get" ] || exit 0

	_protocol=""; _host=""; _path=""
	while IFS='=' read -r _k _v; do
		[ -n "$_k" ] || break
		case "$_k" in
			protocol) _protocol="$_v" ;;
			host) _host="$_v" ;;
			path) _path="$_v" ;;
		esac
	done

	case "$_host" in
		github.com) ;;
		gist.github.com)
			# Need the gist ID. Path is "<id>.git" or "<user>/<id>.git".
			[ -n "$_path" ] || exit 0
			_id="${_path##*/}"
			_id="${_id%.git}"
			[ -n "$_id" ] || exit 0
			_login=$(pick_gist_login "$_id") || exit 0
			_token=$("$GH" auth token -h github.com -u "$_login" 2>/dev/null) || exit 0
			printf 'protocol=%s\nhost=%s\nusername=%s\npassword=%s\n' \
				"$_protocol" "$_host" "$_login" "$_token"
			exit 0
			;;
		*) exit 0 ;;
	esac

	_login=""

	# Fast path: derive from local user.email (set by post-checkout hook).
	_email=$(git config --local user.email 2>/dev/null) || true
	case "$_email" in
		*+*@users.noreply.github.com)
			_candidate="${_email#*+}"
			_candidate="${_candidate%@users.noreply.github.com}"
			if "$GH" auth token -h github.com -u "$_candidate" >/dev/null 2>&1; then
				_login="$_candidate"
			fi
			;;
	esac

	# Slow path: probe by owner/repo from the URL path.
	if [ -z "$_login" ] && [ -n "$_path" ]; then
		_owner="${_path%%/*}"
		_rest="${_path#*/}"
		_repo="${_rest%%/*}"
		_repo="${_repo%.git}"
		if [ -n "$_owner" ] && [ -n "$_repo" ]; then
			_login=$(pick_login "$_owner" "$_repo") || _login=""
		fi
	fi

	[ -n "$_login" ] || exit 0
	_token=$("$GH" auth token -h github.com -u "$_login" 2>/dev/null) || exit 0

	printf 'protocol=%s\nhost=%s\nusername=%s\npassword=%s\n' \
		"$_protocol" "$_host" "$_login" "$_token"
}

# ---- post-checkout hook ---------------------------------------------------

cmd_post_checkout() {
	# Args: prev_head new_head flag (1=branch checkout, 0=file checkout)
	[ "${3-}" = "1" ] || exit 0
	git config --local user.email >/dev/null 2>&1 && exit 0

	_remote=$(git remote get-url origin 2>/dev/null) || exit 0
	case "$_remote" in *github.com*) ;; *) exit 0 ;; esac

	_path="${_remote#*github.com}"
	_path="${_path#:}"; _path="${_path#/}"; _path="${_path%.git}"
	_owner="${_path%%/*}"
	_rest="${_path#*/}"
	_repo="${_rest%%/*}"
	[ -n "$_owner" ] && [ -n "$_repo" ] || exit 0

	_winner=$(pick_login "$_owner" "$_repo") || _winner=""
	[ -n "$_winner" ] || exit 0

	_token=$("$GH" auth token -h github.com -u "$_winner" 2>/dev/null) || exit 0
	_id=$(GH_TOKEN="$_token" "$GH" api user --jq .id 2>/dev/null) || exit 0
	_user=$(GH_TOKEN="$_token" "$GH" api user --jq .login 2>/dev/null) || exit 0
	[ -n "$_id" ] && [ -n "$_user" ] || exit 0

	git config --local user.email "$_id+$_user@users.noreply.github.com"
}

# ---- dispatch -------------------------------------------------------------

case "${1-}" in
	credential)    shift; cmd_credential "$@" ;;
	post-checkout) shift; cmd_post_checkout "$@" ;;
	*) echo "auto-identity: unknown mode '${1-}'" >&2; exit 2 ;;
esac
