import copy
import unittest
from reference import NativeState, MAX_AMOUNT, MAX_NONCE


class NativeTransitionTests(unittest.TestCase):
    def setUp(self): self.state = NativeState({'A': 100}, 'receiver', 10)
    def unchanged_on_failure(self, fn):
        before = copy.deepcopy(self.state.__dict__)
        with self.assertRaises(ValueError): fn()
        self.assertEqual(before, self.state.__dict__)

    def test_burn_supply_and_third_party_mint(self):
        self.state.burn(10, 'A', 'BSC-B', 10)
        self.state.mint_after_receiver_verification(11, 'receiver', 'BSC-C-burn-1', 'D', 4)
        self.assertEqual((self.state.balances, self.state.supply, self.state.burned, self.state.minted), ({'A': 90, 'D': 4}, 94, 10, 4))

    def test_activation_and_burn_validation_are_atomic(self):
        for height, recipient, amount in [(9,'B',1),(10,'',1),(10,'B',0),(10,'B',101),(10,'B',MAX_AMOUNT+1)]:
            self.unchanged_on_failure(lambda: self.state.burn(height, 'A', recipient, amount))
        self.state.nonces['A'] = MAX_NONCE
        self.unchanged_on_failure(lambda: self.state.burn(10,'A','B',1))

    def test_mint_authority_replay_and_failure_atomicity(self):
        self.unchanged_on_failure(lambda:self.state.mint_after_receiver_verification(10,'admin','id','B',1))
        self.unchanged_on_failure(lambda:self.state.mint_after_receiver_verification(9,'receiver','id','B',1))
        self.unchanged_on_failure(lambda:self.state.mint_after_receiver_verification(10,'receiver','id','B',1,True))
        self.state.mint_after_receiver_verification(10,'receiver','id','B',1)
        self.unchanged_on_failure(lambda:self.state.mint_after_receiver_verification(10,'receiver','id','C',1))

    def test_uint256_overflow_rolls_back_processed_id(self):
        self.unchanged_on_failure(lambda:self.state.mint_after_receiver_verification(10,'receiver','id','B',MAX_AMOUNT))
        self.assertNotIn('id',self.state.used)

    def test_deterministic_reexecution_and_reorg_restore(self):
        other=copy.deepcopy(self.state)
        for state in [self.state,other]:
            state.burn(10,'A','B',10)
            state.mint_after_receiver_verification(11,'receiver','id','D',4)
        self.assertEqual(self.state.__dict__,other.__dict__)
        snapshot=copy.deepcopy(self.state.__dict__)
        self.state.burn(12,'D','C',2)
        self.state.__dict__=copy.deepcopy(snapshot)
        self.assertEqual(self.state.__dict__,other.__dict__)


if __name__ == '__main__': unittest.main()
