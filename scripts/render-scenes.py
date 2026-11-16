"""Renders the pet's own animations (scenes/*.py) with the Clawd 400 engine.

Usage: python scripts/render-scenes.py <clone of clawd-400> <out dir>

Each scene file is written like one of the clone's scenes/<theme>.py and named after
its theme. Writes <out>/<slug>.gif and <out>/manifest.json in the clone's manifest
format, for import-assets to pick up next to the clone's own animations.
"""
import importlib.util
import json
import os
import sys

src, out = (os.path.abspath(a) for a in sys.argv[1:3])
sys.path.insert(0, src)
import engine  # noqa: E402  (from the clone)

scenes = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scenes')
os.makedirs(out, exist_ok=True)
for f in os.listdir(out):
    if f.endswith('.gif'):
        os.remove(os.path.join(out, f))

manifest = []
for name in sorted(os.listdir(scenes)):
    if not name.endswith('.py'):
        continue
    theme = name[:-3]
    start = len(engine.REG)
    spec = importlib.util.spec_from_file_location(f'pet_scenes_{theme}', os.path.join(scenes, name))
    spec.loader.exec_module(importlib.util.module_from_spec(spec))
    for e in engine.REG[start:]:
        file = e['slug'] + '.gif'
        engine.save_gif(engine.render(e), os.path.join(out, file), e['dur'])
        manifest.append(dict(file=file, slug=e['slug'], theme=theme, zh=e['zh'], en=e['en']))

json.dump(manifest, open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(f'Rendered {len(manifest)} animations from {scenes}')
