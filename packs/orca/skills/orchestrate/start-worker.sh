#!/usr/bin/env bash
# Check the target before worker-start, then verify that the injected prompt was submitted.
# Usage: bash start-worker.sh <worker-start arguments>
# Last line: DISPATCH <id> <working|submitted|check-manually|blocked-permission|blocked-update>
set -u

preflight_fail() {
  echo "PREFLIGHT FAIL $1: $2"
  echo "DISPATCH - preflight-failed"
  exit 2
}

agent=""
worktree=""
base_branch=""
repo_path="."
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  arg=${args[i]}
  case "$arg" in
    --agent|--worktree|--base-branch|--repo)
      if ((i + 1 >= ${#args[@]})); then preflight_fail arguments "$arg needs a value; supply it and retry"; fi
      value=${args[++i]}
      case "$arg" in
        --agent) agent=$value ;;
        --worktree) worktree=$value ;;
        --base-branch) base_branch=$value ;;
        --repo) [[ $value == path:* ]] && repo_path=${value#path:} ;;
      esac
      ;;
    --agent=*) agent=${arg#--agent=} ;;
    --worktree=*) worktree=${arg#--worktree=} ;;
    --base-branch=*) base_branch=${arg#--base-branch=} ;;
    --repo=path:*) repo_path=${arg#--repo=path:} ;;
  esac
done

# Orca CLI name: same order as the official orchestration skill (ORCA_CLI_COMMAND, orca-dev, orca-ide on Linux, orca).
if [[ -n ${ORCA_CLI_COMMAND:-} ]]; then orca_cmd=$ORCA_CLI_COMMAND
elif [[ -n ${ORCA_DEV_REPO_ROOT:-} ]]; then orca_cmd=orca-dev
elif [[ $(uname -s 2>/dev/null) == Linux ]] && command -v orca-ide >/dev/null 2>&1; then orca_cmd=orca-ide
else orca_cmd=orca
fi
command -v "$orca_cmd" >/dev/null 2>&1 || preflight_fail orca "'$orca_cmd' is not on PATH; set ORCA_CLI_COMMAND or fix PATH"

# Known agent CLIs are checked here; other agents Orca supports are left to worker-start.
case "$agent" in
  codex|opencode|claude)
    command -v "$agent" >/dev/null 2>&1 || preflight_fail agent "'$agent' is not on PATH; install it or fix PATH"
    version=$("$agent" --version 2>&1) || preflight_fail agent "'$agent --version' failed; repair the CLI installation"
    version=${version%%$'\n'*}
    [[ -n $version ]] || preflight_fail agent "'$agent --version' returned no version; repair the CLI installation"
    echo "PREFLIGHT ok $agent $version"
    ;;
  "") ;;
  *) echo "PREFLIGHT skip agent '$agent' (not checked here; worker-start reports a missing CLI)" ;;
esac

if [[ $agent == codex ]]; then
  config="$HOME/.codex/config.toml"
  if [[ ! -f $config ]] || ! grep -Eq '^[[:space:]]*check_for_update_on_startup[[:space:]]*=[[:space:]]*false([[:space:]]*(#.*)?)?$' "$config"; then
    preflight_fail codex-config "set check_for_update_on_startup = false in $config"
  fi
fi

repo_root=$(git -C "$repo_path" rev-parse --show-toplevel 2>/dev/null) || preflight_fail repo "'$repo_path' is not a Git repository; pass --repo path:<repository> or run from one"
if [[ $worktree == new-child || $worktree == new-top-level ]]; then
  [[ -n $base_branch ]] || preflight_fail base-branch "--worktree $worktree needs --base-branch; pass an existing ref"
fi
if [[ -n $base_branch ]] && ! git -C "$repo_root" rev-parse --verify --quiet --end-of-options "${base_branch}^{commit}" >/dev/null 2>&1; then
  preflight_fail base-branch "'$base_branch' does not resolve in '$repo_root'; fetch or choose an existing ref"
fi

if [[ -f $repo_root/.orca/preflight.sh ]]; then
  (cd "$repo_root" && bash .orca/preflight.sh) || preflight_fail project-hook "'$repo_root/.orca/preflight.sh' failed; fix its reported issue and retry"
fi

result=$("$orca_cmd" orchestration worker-start "$@" --json 2>&1)
dispatch=$(printf '%s' "$result" | node -e '
  let s = ""; process.stdin.on("data", c => s += c).on("end", () => {
    try {
      const r = JSON.parse(s).result ?? {};
      process.stdout.write(r.dispatchId ?? r.dispatch?.id ?? r.worker?.dispatchId ?? "");
    } catch {}
  });')
if [[ -z $dispatch ]]; then
  printf '%s\n' "$result" | grep -E '"(ok|failedStage|message|code)"' | head -5
  echo "DISPATCH - start-failed"
  exit 1
fi

if [[ $worktree == new-child || $worktree == new-top-level ]]; then
  created_path=$(printf '%s' "$result" | node -e '
    let s = ""; process.stdin.on("data", c => s += c).on("end", () => {
      try {
        const r = JSON.parse(s).result ?? {};
        const id = r.worktreeId ?? r.worktree?.id ?? r.worker?.worktreeId ?? "";
        const fromId = id.includes("::") ? id.slice(id.indexOf("::") + 2) : "";
        process.stdout.write(r.worktree?.path ?? r.worktreePath ?? r.resource?.worktreePath ?? r.placement?.worktreePath ?? fromId);
      } catch {}
    });')
  if [[ -n $created_path ]]; then
    echo "WORKTREE $created_path"
    if [[ -f $created_path/.orca/postsetup-check.sh ]]; then
      (cd "$created_path" && bash .orca/postsetup-check.sh "$created_path") || echo "POSTSETUP WARN: '$created_path/.orca/postsetup-check.sh' failed; inspect the new worktree setup"
    fi
  fi
fi

screen() {
  "$orca_cmd" orchestration worker-read --dispatch "$dispatch" --source terminal --limit 8 --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", c => s += c).on("end", () => {
      try {
        const t = JSON.parse(s).result?.terminal ?? {};
        const tail = Array.isArray(t.tail) ? t.tail.join("\n") : String(t.tail ?? "");
        const blocked = /Permission required|Allow once|Allow always/i.test(tail) ? "permission" : /Update now/i.test(tail) ? "update" : "";
        const working = /Working|esc to interrupt|esc interrupt|still thinking|Propagating|tokens ·|← [0-9]+ agent|■/.test(tail);
        const pasted = /\[Pasted Content/.test(tail);
        console.log(JSON.stringify({ draft: Boolean(t.draft), working, pasted, blocked, tail: tail.slice(-160) }));
      } catch { console.log(JSON.stringify({ draft: false, working: false, pasted: false, blocked: "", tail: "" })); }
    });'
}

handle=$("$orca_cmd" orchestration worker-show --dispatch "$dispatch" --json 2>/dev/null | grep -o '"term_[^"]*"' | head -1 | tr -d '"')
state="check-manually"
for attempt in 1 2 3; do
  sleep "${ORCA_START_WORKER_SLEEP_SECONDS:-20}"
  info=$(screen)
  if [[ $info == *'"blocked":"permission"'* ]]; then state="blocked-permission"; break; fi
  if [[ $info == *'"blocked":"update"'* ]]; then state="blocked-update"; break; fi
  if [[ $info == *'"working":true'* ]]; then state="working"; break; fi
  if [[ -n $handle ]]; then
    "$orca_cmd" terminal send --terminal "$handle" --enter --json >/dev/null 2>&1 && state="submitted"
  fi
done
if [[ $state != blocked-permission && $state != blocked-update ]]; then
  info=$(screen)
  if [[ $info == *'"blocked":"permission"'* ]]; then state="blocked-permission"
  elif [[ $info == *'"blocked":"update"'* ]]; then state="blocked-update"
  elif [[ $info == *'"working":true'* ]]; then state="working"
  fi
fi
echo "$info"
echo "DISPATCH $dispatch $state"
