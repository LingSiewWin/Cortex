// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  SynapticMarket — minimal judge escrow for the Cortex Synaptic Market.
/// @author Cortex
/// @notice This contract is a **judge escrow only**, not a production marketplace.
///
///         What it IS:
///           - A minimal mechanism for a buyer to send GLM to a seller in
///             exchange for the right to decrypt a specific Arkiv listing.
///           - A canonical `Grant` event that a seller's relayer watches off-chain
///             and answers by publishing a grant entity on Arkiv (the entity
///             carries the decryption key, sealed to the buyer).
///
///         What it is NOT:
///           - No royalties. No protocol fees. No fee splits.
///           - No upgradeability, no proxy, no admin.
///           - No dispute resolution, refunds, or escrow timeout.
///           - No on-chain reputation, ratings, or revocation.
///           - No re-entrancy guard library — `register` is a no-state-mutation
///             advisory write and `buy` uses checks-effects-interactions with a
///             plain `call`. Suitable for the walkthrough, not for real funds.
///
///         The listing key is the Arkiv entity key of the encrypted listing.
///         Sellers self-register price + ownership before publishing the
///         off-chain encrypted payload. Buyers query Arkiv for listings, then
///         call `buy(listingKey)` with `msg.value >= priceOf[listingKey]`.
///         The contract forwards the full `msg.value` to the seller and emits
///         a `Grant`; the seller's relayer answers off-chain.
contract SynapticMarket {
    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @notice Emitted when a seller registers a listing's price and ownership.
    ///         Off-chain indexers can hydrate the marketplace from this event
    ///         alone; the Arkiv listing entity carries the encrypted payload.
    event ListingRegistered(
        bytes32 indexed listingKey,
        address indexed seller,
        uint256 priceWei
    );

    /// @notice Emitted on a successful `buy`. The seller's grant-watcher daemon
    ///         picks this up and writes a grant entity to Arkiv carrying the
    ///         decryption key (sealed to the buyer's pubkey in v2, or filtered
    ///         by `buyer` attribute in v1).
    event Grant(
        bytes32 indexed listingKey,
        address indexed buyer,
        uint256 paidPrice,
        uint256 timestamp
    );

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    /// @notice The seller who registered each listing. Buyers pay this address.
    mapping(bytes32 => address) public sellerOf;

    /// @notice The price (wei) required to buy each listing. Buyers may overpay;
    ///         the overpayment is forwarded to the seller along with the price.
    mapping(bytes32 => uint256) public priceOf;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error AlreadyRegistered(bytes32 listingKey);
    error UnknownListing(bytes32 listingKey);
    error InsufficientPayment(uint256 sent, uint256 required);
    error PaymentForwardFailed();

    // ---------------------------------------------------------------------
    // Functions
    // ---------------------------------------------------------------------

    /// @notice Register a listing's price and seller. One-time per listing key —
    ///         re-registration is rejected so a third party can't squat an
    ///         already-published Arkiv listing's monetization channel.
    /// @param  listingKey The Arkiv entity key of the encrypted listing.
    /// @param  priceWei   The price in wei the buyer must send to `buy`.
    function register(bytes32 listingKey, uint256 priceWei) external {
        if (sellerOf[listingKey] != address(0)) {
            revert AlreadyRegistered(listingKey);
        }
        sellerOf[listingKey] = msg.sender;
        priceOf[listingKey] = priceWei;
        emit ListingRegistered(listingKey, msg.sender, priceWei);
    }

    /// @notice Buy access to a listing. Forwards the full `msg.value` (price +
    ///         any overpayment, e.g. tip) to the seller and emits `Grant`.
    /// @param  listingKey The Arkiv entity key of the encrypted listing.
    function buy(bytes32 listingKey) external payable {
        address seller = sellerOf[listingKey];
        if (seller == address(0)) revert UnknownListing(listingKey);

        uint256 price = priceOf[listingKey];
        if (msg.value < price) revert InsufficientPayment(msg.value, price);

        // Forward full payment to the seller (price + any overpayment / tip).
        (bool ok, ) = seller.call{value: msg.value}("");
        if (!ok) revert PaymentForwardFailed();

        emit Grant(listingKey, msg.sender, msg.value, block.timestamp);
    }
}
