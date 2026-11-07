#!/usr/bin/env python3
"""Compatibility entry point for the shared evolution command implementation."""
from command import main

if __name__ == "__main__":
    raise SystemExit(main(legacy=True))
