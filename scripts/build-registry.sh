#!/usr/bin/env bash
# The registry contract's reproducible build (see build-contract.sh).
exec bash "$(dirname "$0")/build-contract.sh" contracts/registry proctor_registry
