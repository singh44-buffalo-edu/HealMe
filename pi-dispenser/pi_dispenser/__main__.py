"""`python -m pi_dispenser` entrypoint — delegates straight to cli.main().

Exists so the package runs without being installed (the README/Makefile use
`PYTHONPATH=pi-dispenser python -m pi_dispenser ...`); the systemd unit uses
the same invocation on the Pi.
"""

from .cli import main

raise SystemExit(main())
