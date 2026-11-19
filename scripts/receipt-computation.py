"""Pinned RISC Zero receipt computation and SDK verification for the local bridge.

RPC/operator authenticity is trusted. Composite receipts are verified off-chain;
the destination still verifies the receipt MPT, event and replay protection.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
POLICY = json.loads((ROOT / 'configs/receipt-computation.json').read_text())
_spec = importlib.util.spec_from_file_location('receipt_runtime', ROOT / 'scripts/runtime-config.py')
_runtime = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_runtime)
HOST = _runtime.receipt_host()
INPUT_FIELDS = ('action', 'sourceChainId', 'destinationChainId', 'sourceToken',
                'destinationToken', 'sender', 'recipient', 'amount', 'nonce',
                'transferId', 'blockNumber', 'blockHash', 'receiptRoot', 'txIndex',
                'logIndex', 'receiptBytes', 'proofNodes')
RECEIPT_LIMIT = 8 * 1024 * 1024


def input_data(package):
    if not isinstance(package, dict):
        raise ValueError('receipt computation requires a package object')
    result = {name: package[name] for name in INPUT_FIELDS}
    if len(json.dumps(result).encode()) > 16 * 1024 * 1024:
        raise ValueError('computation input oversized')
    return result


def check_summary(summary, policy=None):
    policy = POLICY if policy is None else policy
    if (summary.get('sdkVerified') is not True
            or summary.get('imageId') != policy['imageId']
            or summary.get('sourceAuthenticated') is not False
            or summary.get('onchainVerified') is not False
            or summary.get('journal', {}).get('statement') != policy['statement']
            or summary['journal'].get('sourceAuthenticated') is not False):
        raise ValueError('unexpected RISC Zero guest or proof scope')
    return summary


class Computation:
    def __init__(self, directory, stop, policy=None, host=None):
        self.policy = POLICY if policy is None else policy
        self.host = HOST if host is None else Path(host)
        self.directory = Path(directory)
        self.stop = stop
        self.lock = threading.Lock()
        self.process_lock = threading.Lock()
        self.processes = set()

    def cancel(self):
        with self.process_lock:
            for process in list(self.processes):
                self.terminate(process)

    @staticmethod
    def terminate(process):
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    def run(self, mode, folder):
        if self.stop.is_set():
            raise ValueError('receipt computation service stopping')
        if not self.host.is_file():
            raise ValueError('build bridge-receipt-host first')
        # The bounded worker owns its host and r0vm descendants. Verification is
        # short and never starts a new proof. No shell or remote proving service.
        if mode == 'prove':
            command = [os.sys.executable, str(ROOT / 'scripts/run-receipt-computation.py'),
                       mode, '--input', str(folder / 'input.json'), '--output', str(folder)]
            timeout = 1830
        else:
            command = [str(self.host), 'verify', str(folder / 'input.json'), str(folder)]
            timeout = 30
        env = os.environ.copy()
        env['BNC_RECEIPT_HOST'] = str(self.host)
        for key in ('RISC0_DEV_MODE', 'BONSAI_API_KEY', 'BONSAI_API_URL'):
            env.pop(key, None)
        with (folder / 'sdk.log').open('wb') as log:
            with self.process_lock:
                if self.stop.is_set():
                    raise ValueError('receipt computation service stopping')
                process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                           env=env, start_new_session=True)
                self.processes.add(process)
            started = time.monotonic()
            try:
                while process.poll() is None:
                    if self.stop.wait(.1) or time.monotonic() - started > timeout:
                        self.terminate(process)
                        try:
                            process.wait(timeout=12)
                        except subprocess.TimeoutExpired:
                            os.killpg(process.pid, signal.SIGKILL)
                            process.wait()
                        raise ValueError('RISC Zero computation cancelled or timed out')
                if process.returncode:
                    raise ValueError('RISC Zero SDK ' + mode + ' rejected the receipt/input; inspect ' + str(folder))
            finally:
                with self.process_lock:
                    self.processes.discard(process)
        return check_summary(json.loads((folder / 'summary.json').read_text()), self.policy)

    def attach(self, identifier, package):
        with self.lock:
            data = input_data(package)
            encoded = json.dumps(data, separators=(',', ':')).encode()
            digest = hashlib.sha256(encoded).hexdigest()
            # Cache key includes every guest input. Reorgs or changed metadata
            # cannot silently reuse a receipt for another computation.
            folder = self.directory / (identifier + '-receipt-' + digest)
            folder.mkdir(exist_ok=True)
            (folder / 'input.json').write_bytes(encoded)
            mode = 'verify' if (folder / 'receipt.bin').is_file() else 'prove'
            summary = self.run(mode, folder)
            raw = (folder / 'receipt.bin').read_bytes()
            if not 0 < len(raw) <= RECEIPT_LIMIT:
                raise ValueError('computation receipt exceeds transport cap')
            proof = dict(summary, receiptFormat=self.policy['receiptFormat'],
                         receiptSHA256=hashlib.sha256(raw).hexdigest(),
                         receiptBase64=base64.b64encode(raw).decode())
            return dict(package, computationProof=proof)

    def verify(self, package):
        data = input_data(package)
        proof = package.get('computationProof')
        if not isinstance(proof, dict) or proof.get('receiptFormat') != self.policy['receiptFormat']:
            raise ValueError('RISC Zero composite receipt required')
        check_summary(proof, self.policy)
        text = proof.get('receiptBase64')
        if not isinstance(text, str) or not 0 < len(text) <= (RECEIPT_LIMIT + 2) // 3 * 4:
            raise ValueError('computation receipt transport bounds')
        raw = base64.b64decode(text, validate=True)
        if (not 0 < len(raw) <= RECEIPT_LIMIT
                or hashlib.sha256(raw).hexdigest() != proof.get('receiptSHA256')):
            raise ValueError('computation receipt SHA256 mismatch')
        with tempfile.TemporaryDirectory(prefix='receipt-verify-', dir=self.directory) as name:
            folder = Path(name)
            (folder / 'input.json').write_text(json.dumps(data))
            (folder / 'receipt.bin').write_bytes(raw)
            summary = self.run('verify', folder)
        if summary['journal'] != proof['journal']:
            raise ValueError('computation journal differs from verified receipt')
        return dict(verified=True, imageId=summary['imageId'], journal=summary['journal'],
                    receiptSHA256=proof['receiptSHA256'], sourceAuthenticated=False,
                    onchainVerified=False, verificationLocation='server-risc0-sdk')
