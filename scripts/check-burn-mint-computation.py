#!/usr/bin/env python3
"""Verify actual V2 composite receipts and reject rebindings using the pinned SDK host."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('v2_sdk',ROOT/'scripts/receipt-computation.py')
receipt=importlib.util.module_from_spec(spec);spec.loader.exec_module(receipt)
POLICY=json.loads((ROOT/'configs/burn-mint-computation.json').read_text())


class BurnMintSDKTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='burn-mint-sdk-');self.addCleanup(self.temp.cleanup)
        self.sdk=receipt.Computation(Path(self.temp.name),threading.Event(),POLICY,ROOT/'.bin/bridge-burn-mint-receipt-host')
        self.packages=[json.loads((ROOT/'wallet/testdata'/f'{action}-v2-package.json').read_text()) for action in ['burn-wl','burn-bsc']]

    def test_actual_composites_both_directions_and_current_holder_recipient(self):
        for p in self.packages:
            with self.subTest(action=p['action']):
                result=self.sdk.verify(p)
                self.assertTrue(result['verified']);self.assertEqual(result['journal']['version'],2)
                self.assertEqual(result['imageId'],POLICY['imageId'])
        self.assertNotEqual(self.packages[1]['sender'].lower(),self.packages[1]['recipient'].lower())

    def test_modified_seals_rejected_even_with_recomputed_transport_sha(self):
        for p in self.packages:
            p=copy.deepcopy(p);raw=bytearray(base64.b64decode(p['computationProof']['receiptBase64']));raw[-1]^=1
            p['computationProof'].update(receiptBase64=base64.b64encode(raw).decode(),receiptSHA256=hashlib.sha256(raw).hexdigest())
            with self.assertRaises(ValueError):self.sdk.verify(p)

    def test_actual_receipt_cannot_rebind_event_or_source_block(self):
        for original in self.packages:
            for key,value in [('amount','1'),('recipient','0x'+'11'*20),('sourceToken','0x'+'22'*20),('destinationChainId',56),('blockHash','0x'+'33'*32),('blockNumber',999),('nonce',0)]:
                with self.subTest(action=original['action'],field=key):
                    p=copy.deepcopy(original);p[key]=value
                    with self.assertRaises(ValueError):self.sdk.verify(p)

    def test_old_policy_missing_receipt_and_false_scope_rejected(self):
        for mutate in [lambda p:p.pop('computationProof'),lambda p:p['computationProof'].update(imageId=receipt.POLICY['imageId']),lambda p:p['computationProof'].update(onchainVerified=True)]:
            p=copy.deepcopy(self.packages[0]);mutate(p)
            with self.assertRaises(ValueError):self.sdk.verify(p)


if __name__=='__main__':unittest.main()
