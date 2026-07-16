import sys
from pathlib import Path

# Make `pi_dispenser` importable when pytest is invoked from the repo root
# (e.g. `ai-service/.venv/bin/python -m pytest pi-dispenser/tests -q`).
PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))
