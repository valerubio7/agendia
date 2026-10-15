#!/usr/bin/env python3
"""Generate lettering from supplied SVGs with already-installed native tools.

Run from the repository: python3 -B scripts/outline-brand-assets.py checks fresh
bytes against public assets; --write promotes only four generated SVGs and their
manifest after all checks. Runtime evidence remains in test-results/brand-outlining.
No installation, global font configuration, axis overrides or UI changes occur.
Raster equality certifies this declared reference, not global designer geometry.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import uuid
import xml.etree.ElementTree as ET

ROOT = Path(__file__).absolute().parent.parent
PUBLIC = ROOT / 'apps/web/public'
NAMES = ('primary', 'inverse', 'mono', 'wordmark')
NS = '{http://www.w3.org/2000/svg}'
PINS = {
    'brand/avatar.svg': '61c52cca7cd30bbf70b5d3083de5af53a8b3bebfc9f61e8679873735fa208916',
    'brand/favicon.svg': '5d1e4bb9faa67137482d2822bdaf31523a70b574839f6e73e02cc9d4d275569d',
    'brand/logo-inverse.svg': '0ee47b2c77af7b0f7f31cb42a23f37a8ef8249939c8b919a6b867b4f47332c77',
    'brand/logo-mono.svg': '797c2a55bfb00de4d6c703f195a221e7406c80fbfe30bfeccef471cdec5afae1',
    'brand/logo-primary.svg': '91c6bc52d1efe5a5ab2aaf23f43bad50578ef9c4aee0306e6cd8abd4c71a1103',
    'brand/logo-symbol-inverse.svg': '8e979b1d4b306e8e10de4c6bd9e926eed2d83b4d4d92ff8a47992e24b3dc2d6c',
    'brand/logo-symbol.svg': '31dbc0953e5b46f2afa73c047daeb97905e012e1e7eb77c14bf03023f7c1896f',
    'brand/logo-wordmark.svg': 'f8c72a599f249068b844cf0ee2977d716c6dddf6d59301c341a3ff346a3249bb',
    'fonts/Bricolage.ttf': '413e7357809ddd12fd80a96a8a396de0e401638d4acd3cb3e37532f0472ac682',
    'fonts/JetBrainsMono.ttf': '48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda',
    'fonts/SourceSans3.ttf': '042fe2cc0b933e328410d7acbd0aa6a1873dca5aef81875f4bc214b08825c7b9',
}
CONFIG = '''<fontconfig>
  <dir prefix="relative">font-input</dir>
  <cachedir prefix="relative">cache</cachedir>
  <alias binding="strong">
    <family>Bricolage</family>
    <prefer><family>Bricolage Grotesque</family></prefer>
  </alias>
</fontconfig>
'''


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def safe(path):
    require(path.is_absolute() and path.is_relative_to(ROOT), 'path outside repository')
    require(not any(p.is_symlink() for p in (path, *path.parents)), 'linked path: ' + str(path))
    require(not path.exists() or path.is_file() or path.is_dir(), 'nonordinary path')
    return path


def read(path):
    require(safe(path).is_file(), 'missing ordinary file: ' + str(path))
    return path.read_bytes()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def protected():
    actual = {p: sha(read(PUBLIC / p)) for p in PINS}
    require(actual == PINS, 'protected original bytes differ')
    return actual


def envelope(raw):
    require(b'<!' not in raw and raw.count(b'<?') <= int(raw.startswith(b'<?xml ')), 'glyph XML declarations')
    match = re.fullmatch(rb'(?:<\?xml[^?]*\?>\s*)?(<svg\b[^>]*>)(.*)(</svg>)\s*', raw, re.S)
    require(match is not None, 'SVG envelope')
    return match.groups()


def source_parts(raw, name):
    root = ET.fromstring(raw)
    w, h = (300, 90) if name == 'wordmark' else (388, 120)
    require(root.tag == NS + 'svg' and set(root.attrib) == {'viewBox', 'role', 'aria-label'}, 'source root inheritance')
    require(root.attrib['viewBox'] == f'0 0 {w} {h}' and root.attrib['role'] == 'img', 'source frame')
    texts = list(root.iter(NS + 'text'))
    require(len(texts) == 1 and texts[0] in list(root), 'one direct source text')
    text = texts[0]
    expected = {'x': '6' if name == 'wordmark' else '128', 'y': '62' if name == 'wordmark' else '80',
                'font-size': '56' if name == 'wordmark' else '58', 'font-weight': '800',
                'letter-spacing': '-1', 'font-family': 'Bricolage, Archivo, system-ui, sans-serif'}
    if name == 'mono':
        expected['fill'] = '#1C2620'
        require(not len(text) and text.text == 'agendIA', 'mono direct text')
    else:
        fills = ['#F3EEE1' if name == 'inverse' else '#1C2620', '#FF6B49']
        require([(e.tag, e.attrib, e.text, len(e)) for e in text] ==
                [(NS + 'tspan', {'fill': f}, t, 0) for f, t in zip(fills, ('agend', 'IA'))], 'source tspans')
    require(text.attrib == expected, 'source text attributes')
    blocks = list(re.finditer(rb'<text\b[^>]*>.*?</text>', raw, re.S))
    require(len(blocks) == 1, 'one raw text block')
    block = blocks[0]
    opening = re.match(rb'<svg\b[^>]*>', raw).group()
    closing = re.search(rb'</svg>\s*$', raw).group()
    return raw[:block.start()], block.group(), raw[block.end():], opening, closing, (w, h), root, text


def glyph_body(raw, dimensions):
    _, body, _ = envelope(raw)
    root = ET.fromstring(raw)
    w, h = dimensions
    require(root.tag == NS + 'svg' and root.attrib.get('viewBox') == f'0 0 {w} {h}', 'glyph frame')
    require(set(root.attrib) <= {'viewBox', 'width', 'height', 'version'}, 'glyph root inheritance')
    for key, value in [('width', w), ('height', h)]:
        require(root.attrib.get(key) in (str(value), str(value) + 'px'), 'glyph units')
    paths = 0
    for node in list(root.iter())[1:]:
        tag = node.tag.removeprefix(NS)
        require(node.tag == NS + tag and tag in ('g', 'path'), 'glyph dependency')
        allowed = {'fill', 'fill-rule', 'fill-opacity', 'opacity', 'transform', 'style'}
        require(set(node.attrib) <= allowed | ({'d'} if tag == 'path' else set()), 'glyph attributes')
        require(not (node.text or '').strip() and not (node.tail or '').strip(), 'glyph text')
        attrs = dict(node.attrib)
        for declaration in attrs.pop('style', '').split(';'):
            if declaration.strip():
                key, value = declaration.split(':', 1)
                require(key.strip() in allowed - {'style', 'transform'}, 'unsupported paint')
                attrs[key.strip()] = value.strip()
        for key, value in attrs.items():
            patterns = {'d': r'[MmZzLlHhVvCcSsQqTtAa0-9eE+.,\s-]+',
                        'transform': r'(\s*(matrix|translate|scale|rotate|skewX|skewY)\([0-9eE+.,\s-]+\)\s*)+',
                        'fill': r'#[0-9a-fA-F]{3,8}|rgb\([0-9.% ,]+\)|black|white|none',
                        'fill-rule': r'nonzero|evenodd'}
            require(re.fullmatch(patterns.get(key, r'0(?:\.\d+)?|1(?:\.0+)?'), value), 'invalid geometry/paint')
        if tag == 'path':
            require('d' in node.attrib and not len(node), 'missing path geometry')
            paths += 1
    require(paths > 0, 'missing lettering paths')
    # Attach the first glyph tag to the preserved source indentation, not a blank line.
    return body.removeprefix(b'\n')


def native_version(library, symbol):
    try:
        query = getattr(ctypes.CDLL(library), symbol)
        query.restype = ctypes.c_char_p
        return query().decode('ascii')
    except (OSError, AttributeError):
        return 'UNKNOWN'


def generate(write):
    before = protected()
    base = safe(ROOT / 'test-results/brand-outlining')
    safe(base.parent).mkdir(exist_ok=True)
    base.mkdir(exist_ok=True)
    run = safe(base / ('run-' + uuid.uuid4().hex))
    run.mkdir(mode=0o700)
    for directory in ('font-input', 'cache'):
        (run / directory).mkdir()
    (run / 'font-input/Bricolage.ttf').write_bytes(read(PUBLIC / 'fonts/Bricolage.ttf'))
    (run / 'fonts.conf').write_text(CONFIG)
    env = {'PATH': os.environ.get('PATH', ''), 'LC_ALL': 'C', 'HOME': str(run),
           'FONTCONFIG_FILE': str(run / 'fonts.conf'), 'FONTCONFIG_PATH': str(run),
           'XDG_CACHE_HOME': str(run / 'cache'), 'MAGICK_TEMPORARY_PATH': str(run)}
    commands = []

    def audit_runtime():
        for directory, dirs, files in os.walk(run, followlinks=False):
            for name in dirs + files:
                path = Path(directory) / name
                if path.is_symlink():
                    target = os.readlink(path)
                    pattern = r'([0-9a-f]{32}-[a-z0-9]+\.cache-)([0-9]+)'
                    alias, dest = re.fullmatch(pattern, name), re.fullmatch(pattern, target)
                    require(path.parent == run / 'cache' and alias and dest and alias[1] == dest[1]
                            and alias[2] in ('9', '10', '11') and dest[2] == '12'
                            and Path(target).name == target, 'unsafe cache alias')
                    require(read(path.parent / target), 'empty cache target')
                else:
                    safe(path)

    def command(args):
        result = subprocess.run([str(a) for a in args], cwd=run, env=env,
                                capture_output=True, timeout=120)
        commands.append({'args': [str(a) for a in args], 'exit': result.returncode,
                         'stdout': result.stdout.decode(), 'stderr': result.stderr.decode()})
        audit_runtime()
        require(result.returncode == 0, 'native command failed: ' + str(commands[-1]))
        return commands[-1]

    try:
        require(set((run / 'font-input').iterdir()) == {run / 'font-input/Bricolage.ttf'}, 'private font inventory')
        fields = command(['fc-match', '--format=%{file}\t%{index}\t%{family}\t%{weight}\t%{fontvariations}',
                          'Bricolage:weight=205:size=58'])['stdout'].split('\t')
        require(len(fields) == 5 and Path(fields[0]) == run / 'font-input/Bricolage.ttf', 'private font match')
        require(fields[1] == '0' and fields[3] == '205' and 'Bricolage Grotesque' in fields[2].split(','), 'font face pattern')
        require(sha(read(Path(fields[0]))) == PINS['fonts/Bricolage.ttf'], 'font match SHA')
        versions = {key: command(args)['stdout'].strip() or commands[-1]['stderr'].strip()
                    for key, args in [('rsvg', ['rsvg-convert', '--version']),
                                      ('fontconfig', ['fc-match', '--version']), ('magick', ['magick', '--version'])]}
        versions.update(cairo=native_version('libcairo.so.2', 'cairo_version_string'),
                        pango=native_version('libpango-1.0.so.0', 'pango_version_string'),
                        harfbuzz=native_version('libharfbuzz.so.0', 'hb_version_string'))
        manifest = {'generated': True, 'recipe': 'raw-text-only/rsvg-svg/literal-splice/strict-reference-v1',
                    'effective_axes': None, 'axis_overrides': [], 'sources': before,
                    'fontconfig': CONFIG, 'fontconfig_sha256': sha(CONFIG.encode()),
                    'font': dict(file='font-input/Bricolage.ttf', index=fields[1], family=fields[2],
                                 weight=fields[3], variations=fields[4], sha256=PINS['fonts/Bricolage.ttf']),
                    'versions': versions, 'version_scope': 'CLI facts; libraries queried via native loader, not linked-library attestation',
                    'limitations': 'Effective axes UNKNOWN; reference raster equality only; browser acceptance pending.', 'outputs': {}}
        outputs = {}
        for name in NAMES:
            raw = read(PUBLIC / f'brand/logo-{name}.svg')
            prefix, text, suffix, opening, closing, dimensions, root, node = source_parts(raw, name)
            input_path = run / f'{name}-text.svg'
            input_path.write_bytes(opening + text + closing)
            bodies = []
            for label in ('glyph', 'repeat'):
                path = run / f'{name}-{label}.svg'
                command(['rsvg-convert', '--format=svg', '--output', path, input_path])
                bodies.append(glyph_body(read(path), dimensions))
            require(read(run / f'{name}-glyph.svg') == read(run / f'{name}-repeat.svg'), 'glyph repeat bytes')
            assembled = [prefix + body + suffix for body in bodies]
            require(assembled[0] == assembled[1], 'assembly repeat bytes')
            require(assembled[0][:len(prefix)] == prefix and assembled[0][-len(suffix):] == suffix, 'nontext bytes')
            output = run / f'logo-{name}-outlined.svg'
            output.write_bytes(assembled[0])
            record = {'sha256': sha(assembled[0]), 'nontext': 'BYTE_EQUAL_PREFIX_SUFFIX', 'determinism': 'EXACT_BYTES',
                      'source_params': {'viewBox': root.attrib['viewBox'], 'text': node.attrib}, 'reference': {}}
            for label, factor in [('normal', 1), ('high', 4)]:
                size = [v * factor for v in dimensions]
                pair = []
                for kind, data in [('source', raw), ('outlined', assembled[0])]:
                    svg, png = run / f'{name}-{kind}.svg', run / f'{name}-{kind}-{label}.png'
                    svg.write_bytes(data)
                    command(['rsvg-convert', '--width', size[0], '--height', size[1], '--output', png, svg])
                    require(command(['magick', 'identify', '-format', '%w %h', png])['stdout'] == f'{size[0]} {size[1]}', 'raster dimensions')
                    pair.append(png)
                metrics = {}
                for metric in ('AE', 'RMSE'):
                    result = command(['magick', 'compare', '-metric', metric, *pair, 'null:'])
                    value = result['stderr'].strip()
                    match = re.fullmatch(r'([0-9.eE+-]+)(?:\s+\(([0-9.eE+-]+)\))?', value)
                    require(match and all(float(v) == 0 for v in match.groups() if v is not None), 'nonzero metric')
                    metrics[metric] = value
                record['reference'][label] = dict(dimensions=size, **metrics, exit=0)
                print(name, label, size, metrics, 'exit=0')
            manifest['outputs'][name] = record
            outputs[PUBLIC / f'brand/logo-{name}-outlined.svg'] = assembled[0]
        # One compact line per top-level fact keeps provenance reviewable, not opaque.
        data = '{\n' + ',\n'.join('  ' + json.dumps(k) + ': ' + json.dumps(v, ensure_ascii=True)
                                  for k, v in manifest.items()) + '\n}\n'
        outputs[PUBLIC / 'brand/outlined-provenance.json'] = data.encode()
        require(protected() == before, 'postrun originals changed')
        for path in outputs:
            safe(path)
            require(not path.exists() or path.is_file(), 'public target not ordinary')
        if write:
            for path, content in outputs.items():
                path.write_bytes(content)
        else:
            for path, content in outputs.items():
                require(read(path) == content, 'fresh generation differs: ' + path.name)
        require(protected() == before, 'postpromotion originals changed')
        print('PASS', 'write' if write else 'check-only', 'original11 stable; font/private frame/nontext/repeat verified')
    finally:
        (run / 'commands.json').write_text(json.dumps(commands, indent=2) + '\n')
        require(protected() == before, 'protected originals changed during run')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    generate(parser.parse_args().write)
