#!/usr/bin/env bash
set -euo pipefail

greet() {
    # SC2086: Double quote to prevent globbing and word splitting
    name=$1
    echo Hello $name
}

greet world
