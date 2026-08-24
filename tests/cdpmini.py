#!/usr/bin/env python3
"""Minimal stdlib-only Chrome DevTools Protocol client (no pip deps).

Speaks just enough RFC6455 (client-masked text frames) + CDP to drive the
invariant suite against a headless Chromium started with
  chromium --headless --remote-debugging-port=9223
"""
import base64
import json
import os
import socket
import struct
import urllib.request

PORT = int(os.environ.get('CDP_PORT', '9223'))


def _tab():
    tabs = json.load(urllib.request.urlopen(f'http://localhost:{PORT}/json'))
    pages = [t for t in tabs if t['type'] == 'page']
    if not pages:
        raise SystemExit('no Chrome tab found on :%d' % PORT)
    return pages[0]['webSocketDebuggerUrl']


class WS:
    def __init__(self, url):
        # ws://host:port/path
        rest = url.split('://', 1)[1]
        hostport, _, path = rest.partition('/')
        host, _, port = hostport.partition(':')
        self.sock = socket.create_connection((host, int(port or 80)), timeout=60)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((
            f'GET /{path} HTTP/1.1\r\nHost: {hostport}\r\n'
            'Upgrade: websocket\r\nConnection: Upgrade\r\n'
            f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n'
        ).encode())
        buf = b''
        while b'\r\n\r\n' not in buf:
            buf += self.sock.recv(4096)
        if b' 101 ' not in buf.split(b'\r\n', 1)[0]:
            raise SystemExit('websocket handshake failed')

    def send(self, text):
        payload = text.encode()
        mask = os.urandom(4)
        n = len(payload)
        head = b'\x81'                      # FIN + text
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack('>H', n)
        else:
            head += bytes([0x80 | 127]) + struct.pack('>Q', n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(head + mask + masked)

    def _read_exact(self, n):
        buf = b''
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise SystemExit('websocket closed')
            buf += chunk
        return buf

    def recv(self):
        data = b''
        while True:                          # assemble fragments until FIN
            b1, b2 = self._read_exact(2)
            fin = b1 & 0x80
            ln = b2 & 0x7f
            if ln == 126:
                ln = struct.unpack('>H', self._read_exact(2))[0]
            elif ln == 127:
                ln = struct.unpack('>Q', self._read_exact(8))[0]
            data += self._read_exact(ln)
            if fin:
                return data.decode()


class CDP:
    def __init__(self):
        self.ws = WS(_tab())
        self.mid = 0

    def cmd(self, method, **params):
        self.mid += 1
        self.ws.send(json.dumps({'id': self.mid, 'method': method,
                                 'params': params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get('id') == self.mid:
                if 'error' in msg:
                    raise SystemExit(f'CDP error: {msg["error"]}')
                return msg.get('result', msg)
