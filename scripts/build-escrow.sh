#!/usr/bin/env bash
# The certified-only escrow contract's reproducible build (see build-contract.sh).
exec "$(dirname "$0")/build-contract.sh" contracts/escrow proctor_escrow
