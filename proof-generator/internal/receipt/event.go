package receipt

import (
	"errors"
	"math/big"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
)

type Event struct {
	Sender           common.Address
	Recipient        common.Address
	Amount           *big.Int
	Nonce            uint64
	DestinationChain uint64
}

func EventSignature(action string) string {
	switch action {
	case "lock":
		return "Locked(bytes32,address,address,uint256,uint64,uint256)"
	case "burn":
		return "Burned(bytes32,address,address,uint256,uint64,uint256)"
	case "burn-wl", "burn-bsc":
		return "BridgeBurned(bytes32,address,address,uint256,uint64,uint256)"
	case "lock-vault":
		return "VaultLocked(bytes32,address,address,uint256,uint64,uint256)"
	case "burn-vault":
		return "VaultBurned(bytes32,address,address,uint256,uint64,uint256)"
	}
	return ""
}

func DecodeBridgeEvent(log types.Log, action string, sourceChain uint64, sourceToken, destinationToken common.Address) (*Event, error) {
	return decodeBridgeEvent(log, action, sourceChain, sourceToken, destinationToken, 31337, 31338)
}

func DecodeVaultTestnetEvent(log types.Log, action string, sourceChain uint64, sourceToken, destinationToken common.Address) (*Event, error) {
	if action != "lock-vault" && action != "burn-vault" {
		return nil, errors.New("testnet Vault action required")
	}
	return decodeBridgeEvent(log, action, sourceChain, sourceToken, destinationToken, 10359, 97)
}

func decodeBridgeEvent(log types.Log, action string, sourceChain uint64, sourceToken, destinationToken common.Address, wl, bsc uint64) (*Event, error) {
	v2 := action == "burn-wl" || action == "burn-bsc"
	vault := action == "lock-vault" || action == "burn-vault"
	signature := EventSignature(action)
	if signature == "" {
		return nil, errors.New("unsupported bridge event action")
	}
	if (sourceChain != wl && sourceChain != bsc) || sourceToken == (common.Address{}) || destinationToken == (common.Address{}) {
		return nil, errors.New("unsupported event domain")
	}
	if log.Address != sourceToken || len(log.Topics) != 4 || len(log.Data) != 96 {
		return nil, errors.New("malformed bridge event")
	}
	if log.Removed || log.Topics[0] != crypto.Keccak256Hash([]byte(signature)) {
		return nil, errors.New("removed event or unexpected bridge topic")
	}
	for _, topic := range log.Topics[2:] {
		for _, b := range topic.Bytes()[:12] {
			if b != 0 {
				return nil, errors.New("invalid address topic")
			}
		}
	}
	sender := common.BytesToAddress(log.Topics[2].Bytes()[12:])
	recipient := common.BytesToAddress(log.Topics[3].Bytes()[12:])
	if sender == (common.Address{}) || recipient == (common.Address{}) || (!v2 && !vault && sender != recipient) {
		return nil, errors.New("invalid bridge event sender or recipient")
	}
	amount := new(big.Int).SetBytes(log.Data[:32])
	if amount.Sign() <= 0 {
		return nil, errors.New("zero bridge amount")
	}
	if new(big.Int).SetBytes(log.Data[32:64]).BitLen() > 64 || new(big.Int).SetBytes(log.Data[64:96]).BitLen() > 64 {
		return nil, errors.New("event nonce or chain ID exceeds uint64")
	}
	nonce := new(big.Int).SetBytes(log.Data[32:64]).Uint64()
	destinationChain := new(big.Int).SetBytes(log.Data[64:96]).Uint64()
	if (sourceChain == wl && destinationChain != bsc) || (sourceChain == bsc && destinationChain != wl) {
		return nil, errors.New("unexpected destination chain")
	}
	bytes32, _ := abi.NewType("bytes32", "", nil)
	uint256, _ := abi.NewType("uint256", "", nil)
	address, _ := abi.NewType("address", "", nil)
	uint64Type, _ := abi.NewType("uint64", "", nil)
	args := abi.Arguments{}
	values := []interface{}{}
	if v2 || vault {
		forward := action == "burn-wl" || action == "lock-vault"
		if nonce == 0 || forward != (sourceChain == wl) {
			return nil, errors.New("invalid bridge direction or nonce")
		}
		domain := "WORLDLAND_BNB_BURN_MINT_V2"
		if vault {
			domain = "WORLDLAND_BNB_NATIVE_VAULT_V1"
		}
		args = abi.Arguments{{Type: bytes32}, {Type: uint256}, {Type: address}, {Type: uint256}, {Type: address}, {Type: address}, {Type: address}, {Type: uint256}, {Type: uint64Type}}
		values = []interface{}{crypto.Keccak256Hash([]byte(domain)), new(big.Int).SetUint64(sourceChain), sourceToken, new(big.Int).SetUint64(destinationChain), destinationToken, sender, recipient, amount, nonce}
	} else if action == "lock" {
		args = abi.Arguments{{Type: bytes32}, {Type: uint256}, {Type: address}, {Type: address}, {Type: address}, {Type: address}, {Type: uint256}, {Type: uint64Type}, {Type: uint256}}
		values = []interface{}{crypto.Keccak256Hash([]byte("WORLDLAND_BNB_BRIDGE_LOCK_V2")), new(big.Int).SetUint64(sourceChain),
			sourceToken, destinationToken, sender, recipient, amount, nonce, new(big.Int).SetUint64(destinationChain)}
	} else {
		args = abi.Arguments{{Type: bytes32}, {Type: uint256}, {Type: address}, {Type: uint256}, {Type: address},
			{Type: address}, {Type: address}, {Type: uint256}, {Type: uint64Type}, {Type: uint256}}
		values = []interface{}{crypto.Keccak256Hash([]byte("WORLDLAND_BNB_BRIDGE_BURN_V1")), new(big.Int).SetUint64(sourceChain),
			sourceToken, new(big.Int).SetUint64(destinationChain), destinationToken,
			sender, recipient, amount, nonce, new(big.Int).SetUint64(destinationChain)}
	}
	packed, err := args.Pack(values...)
	if err != nil {
		return nil, err
	}
	if crypto.Keccak256Hash(packed) != log.Topics[1] {
		return nil, errors.New("bridge event ID mismatch")
	}
	return &Event{Sender: sender, Recipient: recipient, Amount: amount, Nonce: nonce, DestinationChain: destinationChain}, nil
}
