#!/usr/bin/env bash
#
# check_ufbt_env.sh
# Diagnostic script to check Python environments and ufbt installations.
#

set -u

BOLD="$(tput bold 2>/dev/null || printf '')"
GREEN="$(tput setaf 2 2>/dev/null || printf '')"
YELLOW="$(tput setaf 3 2>/dev/null || printf '')"
RED="$(tput setaf 1 2>/dev/null || printf '')"
CYAN="$(tput setaf 6 2>/dev/null || printf '')"
RESET="$(tput sgr0 2>/dev/null || printf '')"

header() {
    printf "\n%s=== %s ===%s\n" "${BOLD}${CYAN}" "$1" "${RESET}"
}

success() {
    printf "  %s✔%s %s\n" "${GREEN}" "${RESET}" "$1"
}

warning() {
    printf "  %s!%s %s\n" "${YELLOW}" "${RESET}" "$1"
}

failure() {
    printf "  %s✘%s %s\n" "${RED}" "${RESET}" "$1"
}

info() {
    printf "    %s\n" "$1"
}

header "1. CLI Executables Check"

UFBT_BIN="$(command -v ufbt 2>/dev/null || true)"
if [ -n "$UFBT_BIN" ]; then
    success "ufbt found in PATH: ${BOLD}${UFBT_BIN}${RESET}"
    VERSION_STR="$("$UFBT_BIN" --version 2>&1 | head -n 1 || true)"
    [ -n "$VERSION_STR" ] && info "Version: ${VERSION_STR}"
else
    failure "ufbt is NOT in current PATH"
fi

# Check common alternate binary locations
SEARCH_DIRS=(
    "/opt/homebrew/bin"
    "/usr/local/bin"
    "$HOME/.local/bin"
    "$HOME/Library/Python/3.14/bin"
    "$HOME/Library/Python/3.13/bin"
    "$HOME/Library/Python/3.12/bin"
    "$HOME/Library/Python/3.11/bin"
    "$HOME/Library/Python/3.10/bin"
    "$HOME/Library/Python/3.9/bin"
    "$HOME/.cargo/bin"
)

info "Scanning common standalone locations for ufbt binary..."
FOUND_ANY_BIN=0
for d in "${SEARCH_DIRS[@]}"; do
    if [ -x "$d/ufbt" ]; then
        FOUND_ANY_BIN=1
        if [ "$d/ufbt" = "$UFBT_BIN" ]; then
            info "  - $d/ufbt (currently active in PATH)"
        else
            warning "Found extra binary: $d/ufbt (not first in PATH)"
        fi
    fi
done

if [ "$FOUND_ANY_BIN" -eq 0 ] && [ -z "$UFBT_BIN" ]; then
    info "  No ufbt standalone binaries found in standard locations."
fi

header "2. Python Interpreters & 'ufbt' Module Status"

# Find all python3 candidates
PYTHONS=()

# PATH python3
DEF_PY="$(command -v python3 2>/dev/null || true)"
[ -n "$DEF_PY" ] && PYTHONS+=("$DEF_PY")

# Well-known paths
for p in /opt/homebrew/bin/python3* /usr/local/bin/python3* /usr/bin/python3; do
    if [ -x "$p" ] && [[ ! "$p" =~ -config$ ]]; then
        # Check if already added
        ALREADY=0
        for seen in "${PYTHONS[@]}"; do
            if [ "$seen" = "$p" ]; then
                ALREADY=1
                break
            fi
        done
        [ "$ALREADY" -eq 0 ] && PYTHONS+=("$p")
    fi
done

for py in "${PYTHONS[@]}"; do
    # Skip symlinks that resolve to an already checked binary if the basename is just python3
    PY_VER="$("$py" --version 2>&1 || echo "unknown")"
    printf "\n  Checking: %s%s%s (%s)\n" "${BOLD}" "$py" "${RESET}" "$PY_VER"

    # Test module import
    MODULE_PATH="$("$py" -c "import ufbt; print(ufbt.__file__)" 2>/dev/null || true)"
    if [ -n "$MODULE_PATH" ]; then
        success "'import ufbt' SUCCEEDED"
        info "Module path: ${MODULE_PATH}"
        UFBT_CLI_TEST="$("$py" -m ufbt --version 2>&1 | head -n 1 || true)"
        [ -n "$UFBT_CLI_TEST" ] && info "CLI invocation ('$py -m ufbt'): ${UFBT_CLI_TEST}"
    else
        failure "'import ufbt' FAILED (No module named ufbt)"
    fi
done

header "3. Flipper SDK Directory (~/.ufbt)"

if [ -d "$HOME/.ufbt" ]; then
    success "~/.ufbt directory exists"
    [ -d "$HOME/.ufbt/current" ] && info "Current SDK symlink: $(ls -ld "$HOME/.ufbt/current" 2>/dev/null | awk '{print $NF}' || true)"
    [ -d "$HOME/.ufbt/toolchain" ] && info "Toolchains present: $(ls "$HOME/.ufbt/toolchain" 2>/dev/null | tr '\n' ' ')"
    [ -d "$HOME/.ufbt/download" ] && info "Downloaded SDK archives: $(ls "$HOME/.ufbt/download" 2>/dev/null | tr '\n' ' ')"
else
    warning "~/.ufbt directory does not exist yet (will be created automatically on first run)"
fi

header "4. PATH Environment Summary"

info "PATH: ${PATH}"
if [[ ":$PATH:" != *":/opt/homebrew/bin:"* ]]; then
    warning "/opt/homebrew/bin is NOT in PATH"
else
    success "/opt/homebrew/bin is in PATH"
fi

if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    info "~/.local/bin is NOT in PATH (relevant if using pipx or 'pip install --user')"
fi

header "Summary & Recommendations"

if [ -n "$UFBT_BIN" ]; then
    printf "  %sReady!%s You can run ufbt directly using:\n" "${GREEN}" "${RESET}"
    info "${BOLD}ufbt${RESET}"
elif [ -n "$("${PYTHONS[0]:-python3}" -c "import ufbt; print(1)" 2>/dev/null || true)" ]; then
    printf "  %sReady via Python!%s You can run:\n" "${GREEN}" "${RESET}"
    info "${BOLD}python3 -m ufbt${RESET}"
else
    printf "  %sufbt is not installed in the active environment.%s\n" "${YELLOW}" "${RESET}"
    info "Recommended options:"
    info "  1) Homebrew (cleanest):     brew install ufbt"
    info "  2) pipx (isolated venv):    brew install pipx && pipx install ufbt"
    info "  3) pip into Python 3.14:   python3 -m pip install --break-system-packages ufbt"
fi
printf "\n"
