#!/usr/bin/env python3
"""Actual SDK rejection checks; no new proofs or asset transactions."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('receipt_checks', ROOT / 'scripts/receipt-computation.py')
receipt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipt)


class ReceiptChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='receipt-check-')
        self.addCleanup(self.temp.cleanup)
        self.computation = receipt.Computation(Path(self.temp.name), threading.Event())
        self.package = json.loads((ROOT / 'risc0/receipt-computation/core/fixture.json').read_text())
        summary = json.loads((ROOT / 'results/receipt-computation-lock-proof/summary.json').read_text())
        raw = (ROOT / 'results/receipt-computation-lock-proof/receipt.bin').read_bytes()
        self.package['computationProof'] = dict(summary, receiptFormat=receipt.POLICY['receiptFormat'],
            receiptSHA256=hashlib.sha256(raw).hexdigest(), receiptBase64=base64.b64encode(raw).decode())

    def test_actual_sdk_accepts_original_receipt_and_exact_journal(self):
        verified = self.computation.verify(self.package)
        self.assertTrue(verified['verified'])
        self.assertFalse(verified['sourceAuthenticated'])
        self.assertFalse(verified['onchainVerified'])
        self.assertEqual(verified['imageId'], receipt.POLICY['imageId'])

    def test_modified_receipt_rejected_even_with_new_transport_checksum(self):
        p = copy.deepcopy(self.package)
        raw = bytearray(base64.b64decode(p['computationProof']['receiptBase64']))
        raw[-1] ^= 1
        p['computationProof'].update(receiptBase64=base64.b64encode(raw).decode(), receiptSHA256=hashlib.sha256(raw).hexdigest())
        with self.assertRaises(ValueError):
            self.computation.verify(p)

    def test_amount_and_unverified_block_metadata_cannot_rebind_receipt(self):
        # The block hash is not derived from MPT, but is committed by this guest.
        for key, value in [('amount', '2'), ('blockHash', '0x' + '12' * 32), ('blockNumber', 1000)]:
            with self.subTest(key=key):
                p = copy.deepcopy(self.package)
                p[key] = value
                with self.assertRaises(ValueError):
                    self.computation.verify(p)

    def test_journal_labels_cannot_replace_actual_receipt_journal(self):
        p = copy.deepcopy(self.package)
        p['computationProof']['journal']['amount'] = '2'
        with self.assertRaisesRegex(ValueError, 'journal differs'):
            self.computation.verify(p)

    def test_guest_scope_missing_proof_and_bad_base64_rejected(self):
        for mutate in [lambda p: p.pop('computationProof'),
                       lambda p: p['computationProof'].update(imageId='00' * 32),
                       lambda p: p['computationProof'].update(sdkVerified=False),
                       lambda p: p['computationProof'].update(onchainVerified=True),
                       lambda p: p['computationProof'].update(receiptBase64='!!!!')]:
            p = copy.deepcopy(self.package)
            mutate(p)
            with self.assertRaises(ValueError):
                self.computation.verify(p)

    def test_stopping_service_refuses_new_sdk_processes(self):
        self.computation.stop.set()
        with self.assertRaisesRegex(ValueError, 'stopping'):
            self.computation.verify(self.package)

    def test_cancel_stops_owned_verifier_and_child_process_group(self):
        folder=Path(self.temp.name)
        fake=folder/'slow-host'
        fake.write_text('#!/usr/bin/env python3\nimport subprocess,sys,time\nfrom pathlib import Path\nchild=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"])\nPath(sys.argv[3],"child.pid").write_text(str(child.pid))\ntime.sleep(60)\n')
        fake.chmod(0o755)
        original=self.computation.host
        self.computation.host=fake
        errors=[]
        def run():
            try:self.computation.run('verify',folder)
            except ValueError as error:errors.append(str(error))
        worker=threading.Thread(target=run)
        try:
            worker.start()
            deadline=time.monotonic()+5
            while not (folder/'child.pid').exists() and time.monotonic()<deadline:time.sleep(.02)
            self.assertTrue((folder/'child.pid').exists())
            child=int((folder/'child.pid').read_text())
            self.computation.stop.set()
            self.computation.cancel()
            worker.join(timeout=5)
            self.assertFalse(worker.is_alive())
            self.assertTrue(errors)
            status=Path('/proc')/str(child)/'status'
            if status.exists():self.assertIn('Z',next(x for x in status.read_text().splitlines() if x.startswith('State:')))
            self.assertFalse(self.computation.processes)
        finally:
            self.computation.stop.set();self.computation.cancel();worker.join(timeout=5)
            self.computation.host=original


if __name__ == '__main__':
    unittest.main()
