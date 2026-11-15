"""Load pinned support tools without requiring unused host image renderers."""
import importlib.util
import os
from pathlib import Path
import sys
import types


def load_project(support):
    support = Path(support)
    sys.path.insert(0, str(support))
    # All Git provenance calls are supplied by the captured-input adapter. The
    # Python library can therefore import without a separate host Git executable.
    os.environ.setdefault('GIT_PYTHON_REFRESH', 'quiet')
    renderer = types.ModuleType('render_utils')
    loaded = None

    def render(name, *args, **kwargs):
        nonlocal loaded
        if loaded is None:
            spec = importlib.util.spec_from_file_location('_chipsim_native_render_utils', support / 'render_utils.py')
            loaded = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(loaded)
        return getattr(loaded, name)(*args, **kwargs)

    # Physical hardening never calls these functions. If a caller explicitly
    # requests rendering, execute the unmodified upstream renderer lazily.
    renderer.render_png = lambda *a, **k: render('render_png', *a, **k)
    renderer.render_svg = lambda *a, **k: render('render_svg', *a, **k)
    sys.modules['render_utils'] = renderer
    from project import Project
    return Project
