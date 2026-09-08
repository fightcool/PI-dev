import sys
from pathlib import Path


def test_python_is_project_local_310():
    root = Path(__file__).resolve().parents[1]
    assert sys.version_info[:2] == (3, 10)
    assert Path(sys.prefix) == root / ".venv"
    assert sys.prefix != sys.base_prefix
