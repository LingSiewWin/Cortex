// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  CortexRegistry — Minimal agent registry for the Cortex memory engine.
/// @author Cortex
/// @notice This contract is **event-shape mimicry** per docs/ERC.md §2.6.
///
///         It emits events whose signatures match ERC-8004 (Trustless Agents
///         Registry, Draft) so that any 8004-shaped indexer can read Cortex
///         data without modification — *without* taking a hard dependency on
///         a 9-month-old Draft that has a competing Draft (ERC-8122).
///
///         What it is NOT:
///           - Not a real ERC-8004 reputation / validation / discovery system.
///           - Not an ERC-7857 AI-NFT (no TEE oracle on Arkiv Braga).
///           - Not an ERC-6551 token-bound account (precompile incompatible).
///           - Not a Diamond (ERC-2535) — single file, no proxy.
///
///         What it IS:
///           - ERC-5169 `scriptURI()` pointer to the SQLite-mirror replay
///             script (the Cortex sovereignty story made chain-native).
///           - ERC-8004-shaped events for forward compatibility.
///           - Manual ERC-721-ish ownership via `mapping(uint256 => address) ownerOf`.
///
///         If ERC-8004 reaches Final and wins, the events here already match.
///         If ERC-8122 wins instead, this contract is 80 lines — swap it.
contract CortexRegistry {
    // ---------------------------------------------------------------------
    // ERC-5169: scriptURI
    // ---------------------------------------------------------------------

    /// @dev Immutable script URIs set at deploy time. Points at the SQLite
    ///      mirror replay logic (IPFS pin + GitHub raw fallback).
    string[] private _scriptURIs;

    /// @notice ERC-5169 — URIs to a client-side script anyone can run to
    ///         reconstruct Cortex memory state from chain events alone.
    function scriptURI() external view returns (string[] memory) {
        return _scriptURIs;
    }

    // ---------------------------------------------------------------------
    // ERC-8004-shaped events (event-shape mimicry, NOT a real impl)
    // ---------------------------------------------------------------------

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event MetadataSet(
        uint256 indexed agentId,
        string indexed indexedMetadataKey,
        string metadataKey,
        bytes metadataValue
    );
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);

    // ---------------------------------------------------------------------
    // Ownership
    // ---------------------------------------------------------------------

    /// @notice Owner of each registered agent. Mirrors ERC-721's `ownerOf`
    ///         without dragging in the full ERC-721 surface.
    mapping(uint256 => address) public ownerOf;

    /// @dev Monotonic counter. Starts at 1 so `agentId == 0` always reads
    ///      "unregistered" via `ownerOf`.
    uint256 private _nextAgentId = 1;

    /// @dev Cached URI per agent so the registry is self-contained for
    ///      indexers that aren't crawling event history.
    mapping(uint256 => string) public agentURI;

    error NotOwner(uint256 agentId, address caller);

    modifier onlyAgentOwner(uint256 agentId) {
        if (ownerOf[agentId] != msg.sender) revert NotOwner(agentId, msg.sender);
        _;
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @param scriptURIs_ Immutable list of URIs pointing to the SQLite-mirror
    ///                    replay script (e.g. ipfs + GitHub raw fallback).
    constructor(string[] memory scriptURIs_) {
        _scriptURIs = scriptURIs_;
    }

    // ---------------------------------------------------------------------
    // Registry functions
    // ---------------------------------------------------------------------

    /// @notice Register a new agent. Caller becomes its owner.
    /// @param  uri_ Canonical agent URI (e.g. `arkiv://cortex/<userId>`).
    /// @return agentId Newly-minted agent id (starts at 1).
    function register(string calldata uri_) external returns (uint256 agentId) {
        agentId = _nextAgentId++;
        ownerOf[agentId] = msg.sender;
        agentURI[agentId] = uri_;
        emit Registered(agentId, uri_, msg.sender);
    }

    /// @notice Set arbitrary metadata on an agent. Owner-only.
    /// @dev    `key` is emitted twice — once as `indexed string` (hashed) for
    ///         filterable topics, once as the raw string for indexer convenience.
    ///         This matches the ERC-8004 event shape exactly.
    function setMetadata(uint256 agentId, string calldata key, bytes calldata value)
        external
        onlyAgentOwner(agentId)
    {
        emit MetadataSet(agentId, key, key, value);
    }

    /// @notice Update the canonical URI of an agent. Owner-only.
    function updateURI(uint256 agentId, string calldata newURI)
        external
        onlyAgentOwner(agentId)
    {
        agentURI[agentId] = newURI;
        emit URIUpdated(agentId, newURI, msg.sender);
    }
}
