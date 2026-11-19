"""Native supply state-transition reference AFTER deterministic receiver verification.

Not a node, proof verifier, wallet, or deployable native WL implementation.
Gas escrow and transaction nonce belong to the EVM executor outside this model.
"""
from copy import deepcopy

MAX_AMOUNT = 2**256-1
MAX_NONCE = 2**64-1


class NativeState:
    def __init__(self, balances, receiver, activation_height):
        self.balances = dict(balances)
        self.receiver = receiver
        self.activation_height = activation_height
        self.initial_supply = sum(balances.values())
        self.supply = self.initial_supply
        self.burned = self.minted = 0
        self.nonces = {}
        self.used = set()
        self.events = []

    def _transaction(self, height, transition):
        if height < self.activation_height:
            raise ValueError('inactive')
        snapshot = deepcopy(self.__dict__)
        try:
            transition()
            if self.supply != sum(self.balances.values()):
                raise ValueError('supply/balance mismatch')
            if self.supply != self.initial_supply+self.minted-self.burned:
                raise ValueError('bridge supply mismatch')
            if any(not 0 <= n <= MAX_AMOUNT for n in (self.supply, self.burned, self.minted, *self.balances.values())):
                raise ValueError('uint256 bounds')
        except Exception:
            self.__dict__ = snapshot
            raise

    def burn(self, height, burner, recipient, amount):
        def transition():
            if not recipient or not 0 < amount <= MAX_AMOUNT:
                raise ValueError('invalid burn')
            nonce = self.nonces.get(burner, 0)+1
            if nonce > MAX_NONCE or self.balances.get(burner, 0) < amount:
                raise ValueError('nonce or balance')
            self.balances[burner] -= amount
            self.supply -= amount
            self.burned += amount
            self.nonces[burner] = nonce
            # ABI/keccak are verified by shared Go/Rust/Solidity vectors, not this model.
            self.events.append(('burn', burner, recipient, amount, nonce))
        self._transaction(height, transition)

    def mint_after_receiver_verification(self, height, caller, burn_id, recipient, amount, fail_after_write=False):
        def transition():
            if caller != self.receiver or not burn_id or burn_id in self.used:
                raise ValueError('unauthorized or replay')
            if not recipient or not 0 < amount <= MAX_AMOUNT:
                raise ValueError('invalid mint')
            self.used.add(burn_id)
            self.balances[recipient] = self.balances.get(recipient, 0)+amount
            self.supply += amount
            self.minted += amount
            self.events.append(('mint', burn_id, recipient, amount))
            if fail_after_write:
                raise ValueError('downstream execution reverted')
        self._transaction(height, transition)
