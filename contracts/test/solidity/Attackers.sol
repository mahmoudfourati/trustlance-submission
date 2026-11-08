// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TrustLanceEscrow} from "../../contracts/TrustLanceEscrow.sol";

/// @notice Test-only contract that plays a project role (client, freelancer or arbitrator) and misbehaves when it
/// receives ETH: it reverts, burns all gas, or re-enters the escrow with any calldata.
contract AttackerParty {
    enum Mode {
        Accept,
        Revert,
        BurnGas,
        Reenter
    }

    error ReceiveRejected();

    TrustLanceEscrow public immutable escrow;
    Mode public mode;
    /// @notice Calldata sent to the escrow from inside `receive` in `Reenter` mode.
    bytes public reentryCall;
    bool public reentryAttempted;
    bool public reentrySucceeded;
    bytes public reentryResult;
    uint256 public receiveCount;
    uint256 public received;

    constructor(TrustLanceEscrow escrow_) {
        escrow = escrow_;
    }

    function setMode(Mode mode_, bytes calldata reentryCall_) external {
        mode = mode_;
        reentryCall = reentryCall_;
    }

    /// @notice Calls the escrow as this contract, bubbling up any revert.
    function exec(bytes calldata data) external payable returns (bytes memory result) {
        bool ok;
        (ok, result) = address(escrow).call{value: msg.value}(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    receive() external payable {
        if (mode == Mode.Revert) revert ReceiveRejected();
        if (mode == Mode.BurnGas) {
            while (true) {}
        }
        receiveCount++;
        received += msg.value;
        if (mode == Mode.Reenter && !reentryAttempted) {
            reentryAttempted = true;
            (reentrySucceeded, reentryResult) = address(escrow).call(reentryCall);
        }
    }
}

/// @notice Forces ETH into a contract without calling it, the one way to bypass a missing `receive`.
/// @dev Since Cancun, SELFDESTRUCT still transfers the balance; creating and destroying in one transaction also
/// removes the code.
contract ForceSender {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}
