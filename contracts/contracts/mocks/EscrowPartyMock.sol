// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TrustLanceEscrow} from "../TrustLanceEscrow.sol";

/// @notice Test-only contract that acts as a project party and misbehaves when it receives ETH.
/// @dev Never deployed outside tests.
contract EscrowPartyMock {
    enum ReceiveMode {
        Accept,
        Revert,
        Reenter
    }

    error ReceiveRejected();

    TrustLanceEscrow public immutable escrow;
    ReceiveMode public mode;
    uint256 public receiveCount;
    /// @notice Revert data of the re-entrant `withdraw` attempt, if one was made.
    bytes public reentryError;

    constructor(TrustLanceEscrow escrow_) {
        escrow = escrow_;
    }

    function setMode(ReceiveMode mode_) external {
        mode = mode_;
    }

    function createProject(TrustLanceEscrow.CreateProjectParams calldata params) external payable returns (uint256) {
        return escrow.createProject{value: msg.value}(params);
    }

    function cancelProject(uint256 projectId) external {
        escrow.cancelProject(projectId);
    }

    function raiseDispute(uint256 projectId, string calldata reason) external {
        escrow.raiseDispute(projectId, reason);
    }

    function resolveDispute(uint256 projectId, uint256 freelancerShare) external {
        escrow.resolveDispute(projectId, freelancerShare);
    }

    function settleExpiredDispute(uint256 projectId) external {
        escrow.settleExpiredDispute(projectId);
    }

    function withdraw() external {
        escrow.withdraw();
    }

    receive() external payable {
        if (mode == ReceiveMode.Revert) revert ReceiveRejected();
        receiveCount++;
        if (mode == ReceiveMode.Reenter) {
            try escrow.withdraw() {} catch (bytes memory err) {
                reentryError = err;
            }
        }
    }
}
