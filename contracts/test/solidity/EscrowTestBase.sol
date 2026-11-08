// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TrustLanceEscrow} from "../../contracts/TrustLanceEscrow.sol";

/// @dev Shared deployment and project helpers for the Solidity test suites.
abstract contract EscrowTestBase is Test {
    uint16 internal constant FEE_BPS = 250;
    uint32 internal constant REVIEW = 7 days;
    uint32 internal constant DELIVERY = 10 days;
    string internal constant CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

    TrustLanceEscrow internal escrow;
    address internal admin = makeAddr("admin");
    address internal arbitrator = makeAddr("arbitrator");
    address internal client = makeAddr("client");
    address internal freelancer = makeAddr("freelancer");
    address internal outsider = makeAddr("outsider");

    function _deploy() internal {
        escrow = new TrustLanceEscrow(admin, arbitrator, FEE_BPS);
    }

    function _params(address freelancer_, uint256[] memory amounts, uint32 reviewWindow)
        internal
        view
        returns (TrustLanceEscrow.CreateProjectParams memory params, uint256 total)
    {
        TrustLanceEscrow.MilestoneInput[] memory milestones = new TrustLanceEscrow.MilestoneInput[](amounts.length);
        for (uint256 i = 0; i < amounts.length; i++) {
            milestones[i] = TrustLanceEscrow.MilestoneInput({amount: amounts[i], deliveryPeriod: DELIVERY, title: "Milestone"});
            total += amounts[i];
        }
        params = TrustLanceEscrow.CreateProjectParams({
            freelancer: freelancer_,
            acceptanceDeadline: uint64(block.timestamp + 3 days),
            reviewWindow: reviewWindow,
            title: "Project",
            description: "",
            milestones: milestones
        });
    }

    /// Creates and funds a project from `client_` (dealt the ETH it needs) and returns its id.
    function _create(address client_, address freelancer_, uint256[] memory amounts) internal returns (uint256 id) {
        (TrustLanceEscrow.CreateProjectParams memory params, uint256 total) = _params(freelancer_, amounts, REVIEW);
        vm.deal(client_, client_.balance + total);
        vm.prank(client_);
        id = escrow.createProject{value: total}(params);
    }

    function _createAccepted(address client_, address freelancer_, uint256[] memory amounts) internal returns (uint256 id) {
        id = _create(client_, freelancer_, amounts);
        vm.prank(freelancer_);
        escrow.acceptProject(id);
    }

    function _amounts(uint256 a) internal pure returns (uint256[] memory amounts) {
        amounts = new uint256[](1);
        amounts[0] = a;
    }

    function _amounts(uint256 a, uint256 b) internal pure returns (uint256[] memory amounts) {
        amounts = new uint256[](2);
        amounts[0] = a;
        amounts[1] = b;
    }

    function _amounts(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory amounts) {
        amounts = new uint256[](3);
        amounts[0] = a;
        amounts[1] = b;
        amounts[2] = c;
    }

    /// Invariant 1, with forced ETH counted separately so the check is exact.
    function _assertConservation(uint256 forced) internal view {
        assertEq(address(escrow).balance, escrow.totalEscrow() + escrow.totalWithdrawable() + forced, "balance accounting");
    }

    /// keccak of one project's whole on-chain record (project struct and milestones), to prove it didn't change.
    function _recordHash(uint256 id) internal view returns (bytes32) {
        return keccak256(abi.encode(escrow.getProject(id), escrow.getMilestones(id)));
    }
}
