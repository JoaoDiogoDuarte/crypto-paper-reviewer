#!/usr/bin/env python3
"""Download the local neural voices used by the editor into .cache/voices.

    .venv/bin/python get_voices.py

Kokoro-82M (about 340 MB, several US and British voices) and four Piper
voices (about 60-120 MB each).  Both run offline on the CPU.
"""
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEST = os.path.join(HERE, '.cache', 'voices')

KOKORO = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/'
PIPER = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/'
PIPER_VOICES = ['en_US-lessac-high', 'en_US-ryan-high', 'en_GB-cori-high', 'en_GB-northern_english_male-medium']


def fetch(url, path):
    if os.path.exists(path):
        print('have', os.path.basename(path))
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    print('get ', os.path.basename(path), flush=True)
    tmp = path + '.part'
    urllib.request.urlretrieve(url, tmp)
    os.replace(tmp, path)


def main():
    for f in ['kokoro-v1.0.onnx', 'voices-v1.0.bin']:
        fetch(KOKORO + f, os.path.join(DEST, 'kokoro', f))
    for v in PIPER_VOICES:
        lang, name, quality = v.split('-')
        base = f'{PIPER}{lang}/{name}/{quality}/{v}.onnx'
        fetch(base, os.path.join(DEST, 'piper', v + '.onnx'))
        fetch(base + '.json', os.path.join(DEST, 'piper', v + '.onnx.json'))


if __name__ == '__main__':
    sys.exit(main())
