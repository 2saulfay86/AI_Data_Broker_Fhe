pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract AIDataBrokerFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public batchClosed;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    // Encrypted data storage
    mapping(uint256 => mapping(address => euint32)) public encryptedUserScores; // batchId => user => score
    mapping(uint256 => mapping(address => euint32)) public encryptedUserDataUsageCounts; // batchId => user => usageCount
    mapping(uint256 => euint32) public encryptedBatchTotalScore; // batchId => totalScore
    mapping(uint256 => euint32) public encryptedBatchTotalUsageCount; // batchId => totalUsageCount

    // ACL for data access by companies (provider addresses)
    mapping(address => mapping(uint256 => bool)) public companyBatchAccess; // company => batchId => hasAccess

    // Custom Errors
    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosedOrInvalid();
    error InvalidParameter();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    // Events
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PauseToggled(bool paused);
    event CooldownSecondsChanged(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 batchId);
    event BatchClosed(uint256 batchId);
    event DataSubmitted(address indexed user, uint256 batchId, euint32 encryptedScore, euint32 encryptedUsageCount);
    event CompanyAccessGranted(address indexed company, uint256 batchId);
    event CompanyAccessRevoked(address indexed company, uint256 batchId);
    event DecryptionRequested(uint256 requestId, uint256 batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 requestId, uint256 batchId, uint32 totalScore, uint32 totalUsageCount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true; // Owner is a provider by default
        emit ProviderAdded(owner);
        currentBatchId = 1; // Start with batch 1
        cooldownSeconds = 60; // Default cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (provider == address(0)) revert InvalidParameter();
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (provider == owner) revert InvalidParameter(); // Cannot remove owner
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseToggled(_paused);
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSecondsChanged(oldCooldown, _cooldownSeconds);
    }

    function openNewBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner {
        if (batchId == 0 || batchId > currentBatchId || batchClosed[batchId]) revert BatchClosedOrInvalid();
        batchClosed[batchId] = true;
        emit BatchClosed(batchId);
    }

    function grantCompanyAccess(address company, uint256 batchId) external onlyOwner {
        if (batchId == 0 || batchId > currentBatchId || !batchClosed[batchId]) revert BatchClosedOrInvalid();
        if (!companyBatchAccess[company][batchId]) {
            companyBatchAccess[company][batchId] = true;
            emit CompanyAccessGranted(company, batchId);
        }
    }

    function revokeCompanyAccess(address company, uint256 batchId) external onlyOwner {
        if (batchId == 0 || batchId > currentBatchId) revert BatchClosedOrInvalid();
        if (companyBatchAccess[company][batchId]) {
            companyBatchAccess[company][batchId] = false;
            emit CompanyAccessRevoked(company, batchId);
        }
    }

    function submitEncryptedData(
        euint32 encryptedScore,
        euint32 encryptedUsageCount
    ) external whenNotPaused {
        _requireInitialized(encryptedScore);
        _requireInitialized(encryptedUsageCount);

        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastSubmissionTime[msg.sender] = block.timestamp;

        uint256 batchId = currentBatchId;
        if (batchClosed[batchId]) revert BatchClosedOrInvalid();

        encryptedUserScores[batchId][msg.sender] = encryptedScore;
        encryptedUserDataUsageCounts[batchId][msg.sender] = encryptedUsageCount;

        // Update batch aggregates
        if (!FHE.isInitialized(encryptedBatchTotalScore[batchId])) {
            encryptedBatchTotalScore[batchId] = encryptedScore;
            encryptedBatchTotalUsageCount[batchId] = encryptedUsageCount;
        } else {
            encryptedBatchTotalScore[batchId] = encryptedBatchTotalScore[batchId].add(encryptedScore);
            encryptedBatchTotalUsageCount[batchId] = encryptedBatchTotalUsageCount[batchId].add(encryptedUsageCount);
        }

        emit DataSubmitted(msg.sender, batchId, encryptedScore, encryptedUsageCount);
    }

    function requestBatchDecryption(uint256 batchId) external onlyProvider whenNotPaused {
        if (batchId == 0 || batchId > currentBatchId || !batchClosed[batchId]) revert BatchClosedOrInvalid();
        if (!companyBatchAccess[msg.sender][batchId]) revert NotProvider(); // Provider must have access to this batch

        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        euint32 memory totalScore = encryptedBatchTotalScore[batchId];
        euint32 memory totalUsageCount = encryptedBatchTotalUsageCount[batchId];
        _requireInitialized(totalScore);
        _requireInitialized(totalUsageCount);

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(totalScore);
        cts[1] = FHE.toBytes32(totalUsageCount);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();
        // Security: Replay protection prevents processing the same decryption request multiple times.

        DecryptionContext memory ctx = decryptionContexts[requestId];
        uint256 batchId = ctx.batchId;

        // Security: Rebuild ciphertexts from current contract state in the exact same order
        // as during requestBatchDecryption to ensure state consistency.
        euint32 memory currentTotalScore = encryptedBatchTotalScore[batchId];
        euint32 memory currentTotalUsageCount = encryptedBatchTotalUsageCount[batchId];
        _requireInitialized(currentTotalScore);
        _requireInitialized(currentTotalUsageCount);

        bytes32[] memory currentCts = new bytes32[](2);
        currentCts[0] = FHE.toBytes32(currentTotalScore);
        currentCts[1] = FHE.toBytes32(currentTotalUsageCount);

        bytes32 currentStateHash = _hashCiphertexts(currentCts);
        if (currentStateHash != ctx.stateHash) revert StateMismatch();
        // Security: State hash verification ensures that the contract state relevant to the
        // decryption request has not changed since the request was made.

        FHE.checkSignatures(requestId, cleartexts, proof);
        // Security: Proof verification ensures the decryption proof is valid and signed by the FHEVM key.

        (uint32 totalScoreCleartext, uint32 totalUsageCountCleartext) = abi.decode(cleartexts, (uint32, uint32));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, batchId, totalScoreCleartext, totalUsageCountCleartext);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 storage val) internal {
        if (!FHE.isInitialized(val)) {
            val = FHE.asEuint32(0);
        }
    }

    function _requireInitialized(euint32 val) internal pure {
        if (!FHE.isInitialized(val)) revert NotInitialized();
    }
}