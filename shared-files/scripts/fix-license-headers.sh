#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GO_FILE="$SCRIPT_DIR/fix-license-headers.go"

if [[ ! -f "$GO_FILE" ]]; then
    echo "Error: $GO_FILE not found" >&2
    exit 1
fi

echo "Running license header fixer..."
go run "$GO_FILE"
