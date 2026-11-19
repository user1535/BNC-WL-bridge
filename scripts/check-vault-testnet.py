#!/usr/bin/env python3
"""Offline checks for the testnet service, using synthetic receipts rather than live contracts."""
import importlib.util
from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Lock
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('vault_testnet', ROOT/'scripts/vault-testnet.py')
testnet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(testnet)


class TestnetChecks(unittest.TestCase):
    def test_reader_rejects_broadcast_and_admin_methods_before_network(self):
        reader = testnet.ReadSession.__new__(testnet.ReadSession)
        for method in ('eth_sendRawTransaction', 'eth_sendTransaction', 'anvil_mine'):
            with self.assertRaisesRegex(ValueError, 'read-only'):
                reader.rpc('wl', method, [])

    def test_chain_guard_rejects_seoul_as_gwangju(self):
        reader = testnet.ReadSession.__new__(testnet.ReadSession)
        reader.guard_lock = testnet.threading.Lock()
        reader.guard_time = float('-inf')
        reader.rpc = lambda chain, method, params: hex(103 if chain == 'wl' else 97)
        with self.assertRaisesRegex(ValueError, 'chain ID mismatch'):
            reader.guard()

    def test_root_proposal_uses_confirmed_source_and_has_no_signer(self):
        api = testnet.api
        service = api.Service.__new__(api.Service)
        service.audit = None
        service.testnet = True
        service.demo_mine = False
        block_hash, receipt_root = '0x' + '11' * 32, '0x' + '22' * 32
        registry, operator = '0x' + '33' * 20, '0x' + '44' * 20
        service.manifest = {'chains': {'wl': {'id': 10359}, 'bnb': {'id': 97}}}
        service.session = SimpleNamespace(
            route=lambda action: ('wl','bnb','source','target',registry,'receiver'),
            confirmations={'wl': 3, 'bnb': 5}, operators={'bnb': operator},
            rpc=lambda chain, method, params: '0x9' if method == 'eth_blockNumber'
                else {'hash': block_hash, 'receiptsRoot': receipt_root},
            registered_header=lambda chain, number: ('0x' + '00' * 32,) * 2,
            view=lambda chain, target, signature, *args: operator if signature.startswith('devOperator')
                else 'true' if signature == 'active()(bool)' else 'false',
        )
        service.event_info = lambda job: {'block': 6, 'hash': block_hash}
        job = {'request': {'action': 'lock-vault', 'fromBlock': 6}}
        result = service.prepare_trusted_root(job)
        self.assertEqual(result['state'], 'waiting_root')
        tx = result['rootRegistration']
        self.assertEqual((tx['chainId'], tx['operator'], tx['to'], tx['value']), (97, operator, registry, '0x0'))
        self.assertEqual(tx['sourceChainId'], 10359)
        self.assertTrue(tx['data'].endswith(receipt_root[2:]))
        self.assertNotIn('signature', tx)
        service.session.registered_header = lambda chain, number: (block_hash, '0x' + '33' * 32)
        with self.assertRaisesRegex(ValueError, '미사용 루트'):
            service.prepare_trusted_root(job)
        view = service.session.view
        service.session.view = lambda *args: 'true' if args[2].startswith('consumedHeaders') else view(*args)
        with self.assertRaisesRegex(ValueError, '지급·발행한 청구'):
            service.prepare_trusted_root(job)
        service.session.registered_header = lambda chain, number: (block_hash, receipt_root)
        service.session.view = lambda *args: 'false' if args[2] == 'active()(bool)' else view(*args)
        self.assertEqual(service.prepare_trusted_root(job)['state'], 'waiting_registry')

    def test_completed_jobs_do_not_exhaust_active_capacity(self):
        service = testnet.api.Service.__new__(testnet.api.Service)
        service.audit, service.vault = None, False
        service.lock = Lock()
        service.actions = {'lock-vault'}
        service.save = lambda job: service.job_status.update({job['id']: job})
        service.job_status = {str(i): {'state': 'ready'} for i in range(256)}
        with TemporaryDirectory() as directory:
            service.directory = Path(directory)
            request = dict(action='lock-vault', transferId='0x' + '11' * 32, fromBlock=1)
            self.assertEqual(service.submit(request)['state'], 'queued')
            service.job_status.update({str(i): {'state': 'waiting_registry'} for i in range(255)})
            with self.assertRaisesRegex(ValueError, 'active proof job capacity'):
                service.submit(dict(request, fromBlock=2))

    def test_provider_log_limit_is_split_in_order_and_bounded(self):
        reader = testnet.ReadSession.__new__(testnet.ReadSession)
        calls = []

        def rpc(chain, method, params, timeout=15):
            if method == 'eth_blockNumber':
                return '0x8'
            first = int(params[0]['fromBlock'], 16)
            to = params[0]['toBlock']
            calls.append((first, to))
            if to == 'latest' or int(to, 16) > first:
                raise testnet.LogRangeLimit('provider cap')
            return [first]

        reader._rpc = rpc
        self.assertEqual(reader.rpc('wl', 'eth_getLogs', [{'fromBlock':'0x5','toBlock':'latest'}]), [5,6,7,8])
        calls.clear()
        with self.assertRaisesRegex(testnet.LogRangeLimit, 'select a more recent'):
            reader.rpc('wl', 'eth_getLogs', [{'fromBlock':'0x1','toBlock':'0x100'}])
        self.assertEqual(len(calls), 33)

    def test_unsigned_incident_plans_are_bound_to_both_registries(self):
        contracts = {name: '0x' + str(i) * 40 for i, name in
                     enumerate(('original', 'wrapped', 'wl_headers', 'bnb_headers'), 1)}
        operators = {'wl': '0x' + '5' * 40, 'bnb': '0x' + '6' * 40}
        config = SimpleNamespace(read_text=lambda: json.dumps(dict(contracts=contracts, operators=operators)))
        digest = '0x' + '77' * 32
        with redirect_stdout(StringIO()) as output:
            testnet.pause_plan(SimpleNamespace(config=config, evidence_digest=digest))
        plan = json.loads(output.getvalue())
        self.assertFalse(plan['broadcast'])
        self.assertEqual([(tx['chainId'], tx['to'], tx['sender']) for tx in plan['transactions']],
            [(10359, contracts['wl_headers'], operators['wl']), (97, contracts['bnb_headers'], operators['bnb'])])
        self.assertTrue(all(tx['data'].endswith(digest[2:]) for tx in plan['transactions']))
        with self.assertRaisesRegex(ValueError, 'nonzero'):
            testnet.pause_plan(SimpleNamespace(config=config, evidence_digest='0x' + '00' * 32))

        old = '0x' + '11' * 32
        reader = SimpleNamespace(data={'contracts':contracts}, operators=operators,
            registered_header=lambda chain, number: (old, old),
            view=lambda chain, target, signature, *args: 'false',
            rpc=lambda chain, method, params: {'hash':digest,'receiptsRoot':digest})
        with patch.object(testnet, 'ReadSession', return_value=reader), patch.object(testnet, 'check_sdk_runtime') as sdk:
            with redirect_stdout(StringIO()) as output:
                testnet.operator_plan(SimpleNamespace(config=config, command='activate-plan'))
            sdk.assert_called_once()
            self.assertEqual([tx['chainId'] for tx in json.loads(output.getvalue())['transactions']], [10359,97])
            with redirect_stdout(StringIO()) as output:
                testnet.operator_plan(SimpleNamespace(config=config, command='invalidate-plan', source='wl', block=1))
            tx, = json.loads(output.getvalue())['transactions']
            self.assertEqual((tx['chainId'], tx['to'], tx['sender']), (97, contracts['bnb_headers'], operators['bnb']))
            self.assertTrue(tx['data'].endswith('00' * 64))
            reader.view = lambda chain, target, signature, *args: 'true' if signature.startswith('consumedHeaders') else 'false'
            with self.assertRaisesRegex(ValueError, 'unconsumed'):
                testnet.operator_plan(SimpleNamespace(config=config, command='invalidate-plan', source='wl', block=1))

    def test_preview_blocks_mismatched_root_before_publishing_proposal(self):
        service = testnet.api.Service.__new__(testnet.api.Service)
        service.audit = None
        service.testnet = True
        service.proof_binary = '/tmp/testnet-probe'
        service.manifest = {'chains': {'wl': {'id': 10359, 'rpc': 'private-not-in-argv'},
                                       'bnb': {'id': 97, 'rpc': 'private-not-in-argv'}}, 'mode': 'dev'}
        service.session = SimpleNamespace(guard=lambda: None,
            route=lambda action: ('wl','bnb','source','target','registry','receiver'),
            confirmations={'wl': 3}, endpoints={'wl': 'https://wl.invalid/secret', 'bnb': 'https://bnb.invalid/secret'})
        root = '0x' + '11' * 32
        proposal = {'state':'waiting_root', 'rootRegistration':dict(blockNumber=6, blockHash=root, receiptRoot=root)}
        service.prepare_trusted_root = lambda job: proposal
        job = {'request': {'action':'lock-vault', 'transferId':root, 'fromBlock':6}}
        with patch.object(testnet.api.subprocess, 'run') as run:
            run.return_value = SimpleNamespace(returncode=0, stderr=b'',
                stdout=json.dumps(dict(blockNumber=6, blockHash=root, receiptRoot='different')).encode())
            with self.assertRaisesRegex(ValueError, 'differs'):
                service.generate(job)
            self.assertIn('--preview-root', run.call_args.args[0])
            self.assertNotIn('https://wl.invalid/secret', run.call_args.args[0])
            run.return_value.stdout = json.dumps(dict(blockNumber=6, blockHash=root, receiptRoot=root)).encode()
            self.assertEqual(service.generate(job), proposal)


if __name__ == '__main__':
    unittest.main()
