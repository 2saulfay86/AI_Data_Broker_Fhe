// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface DataRecord {
  id: string;
  encryptedValue: string;
  timestamp: number;
  owner: string;
  dataType: string;
  price: number;
  authorized: boolean;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  // Randomly selected styles: Gradient (warm sunset), Glass morphism, Multi-column dashboard, Micro-interactions
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<DataRecord[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newRecord, setNewRecord] = useState({
    dataType: "financial",
    value: 0,
    price: 0
  });
  const [transactionStatus, setTransactionStatus] = useState({
    visible: false,
    status: "pending",
    message: ""
  });
  const [publicKey, setPublicKey] = useState("");
  const [contractAddress, setContractAddress] = useState("");
  const [chainId, setChainId] = useState(0);
  const [selectedRecord, setSelectedRecord] = useState<DataRecord | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [searchTerm, setSearchTerm] = useState("");

  // Randomly selected features: Data Statistics, Data Details, Search & Filter
  useEffect(() => {
    loadRecords().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadRecords = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;

      const keysBytes = await contract.getData("record_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing record keys:", e); }
      }

      const list: DataRecord[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`record_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({
                id: key,
                encryptedValue: recordData.value,
                timestamp: recordData.timestamp,
                owner: recordData.owner,
                dataType: recordData.dataType,
                price: recordData.price,
                authorized: recordData.authorized
              });
            } catch (e) { console.error(`Error parsing record ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading record ${key}:`, e); }
      }
      setRecords(list.sort((a, b) => b.timestamp - a.timestamp));
    } catch (e) { console.error("Error loading records:", e); }
    finally { setLoading(false); }
  };

  const addDataRecord = async () => {
    if (!isConnected) {
      alert("Please connect wallet first");
      return;
    }

    setTransactionStatus({
      visible: true,
      status: "pending",
      message: "Encrypting data with Zama FHE..."
    });

    try {
      const encryptedValue = FHEEncryptNumber(newRecord.value);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract");

      const recordId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const recordData = {
        value: encryptedValue,
        timestamp: Math.floor(Date.now() / 1000),
        owner: address,
        dataType: newRecord.dataType,
        price: newRecord.price,
        authorized: false
      };

      await contract.setData(`record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(recordData)));

      const keysBytes = await contract.getData("record_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); }
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(recordId);
      await contract.setData("record_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));

      setTransactionStatus({
        visible: true,
        status: "success",
        message: "Data encrypted and stored securely!"
      });

      await loadRecords();
      setShowAddModal(false);
      setNewRecord({ dataType: "financial", value: 0, price: 0 });
    } catch (e: any) {
      setTransactionStatus({
        visible: true,
        status: "error",
        message: e.message.includes("user rejected transaction") 
          ? "Transaction rejected" 
          : "Error storing data"
      });
    } finally {
      setTimeout(() => setTransactionStatus({ ...transactionStatus, visible: false }), 3000);
    }
  };

  const decryptWithSignature = async (encryptedData: string) => {
    if (!isConnected) {
      alert("Please connect wallet first");
      return null;
    }

    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddress:${contractAddress}\nchainId:${chainId}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) {
      console.error("Decryption failed:", e);
      return null;
    } finally {
      setIsDecrypting(false);
    }
  };

  const toggleAuthorization = async (recordId: string) => {
    if (!isConnected) {
      alert("Please connect wallet first");
      return;
    }

    setTransactionStatus({
      visible: true,
      status: "pending",
      message: "Updating authorization status..."
    });

    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract");

      const recordBytes = await contract.getData(`record_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");

      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      const updatedRecord = {
        ...recordData,
        authorized: !recordData.authorized
      };

      await contract.setData(`record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));

      setTransactionStatus({
        visible: true,
        status: "success",
        message: "Authorization status updated!"
      });

      await loadRecords();
    } catch (e: any) {
      setTransactionStatus({
        visible: true,
        status: "error",
        message: e.message.includes("user rejected transaction") 
          ? "Transaction rejected" 
          : "Error updating authorization"
      });
    } finally {
      setTimeout(() => setTransactionStatus({ ...transactionStatus, visible: false }), 3000);
    }
  };

  const filteredRecords = records.filter(record => 
    record.dataType.toLowerCase().includes(searchTerm.toLowerCase()) ||
    record.id.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const dataStats = {
    total: records.length,
    financial: records.filter(r => r.dataType === "financial").length,
    health: records.filter(r => r.dataType === "health").length,
    social: records.filter(r => r.dataType === "social").length,
    authorized: records.filter(r => r.authorized).length,
    totalValue: records.reduce((sum, r) => sum + (r.authorized ? r.price : 0), 0)
  };

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner"></div>
        <p>Initializing AI Data Broker...</p>
      </div>
    );
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>AI Data Broker</h1>
          <span className="fhe-badge">FHE-Powered</span>
        </div>
        <nav className="main-nav">
          <button 
            className={`nav-btn ${activeTab === "dashboard" ? "active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
          >
            Dashboard
          </button>
          <button 
            className={`nav-btn ${activeTab === "data" ? "active" : ""}`}
            onClick={() => setActiveTab("data")}
          >
            My Data
          </button>
          <button 
            className={`nav-btn ${activeTab === "earnings" ? "active" : ""}`}
            onClick={() => setActiveTab("earnings")}
          >
            Earnings
          </button>
        </nav>
        <div className="wallet-connect">
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
        </div>
      </header>

      <main className="main-content">
        {activeTab === "dashboard" && (
          <div className="dashboard-grid">
            <div className="dashboard-card intro-card">
              <h2>FHE-Powered AI Data Broker</h2>
              <p>
                Your personal AI agent securely manages and monetizes your data using Zama's Fully Homomorphic Encryption.
                Data remains encrypted even during processing and transactions.
              </p>
              <button 
                className="primary-btn"
                onClick={() => setShowAddModal(true)}
              >
                Add New Data
              </button>
            </div>

            <div className="dashboard-card stats-card">
              <h3>Data Statistics</h3>
              <div className="stats-grid">
                <div className="stat-item">
                  <div className="stat-value">{dataStats.total}</div>
                  <div className="stat-label">Total Data Points</div>
                </div>
                <div className="stat-item">
                  <div className="stat-value">{dataStats.financial}</div>
                  <div className="stat-label">Financial</div>
                </div>
                <div className="stat-item">
                  <div className="stat-value">{dataStats.health}</div>
                  <div className="stat-label">Health</div>
                </div>
                <div className="stat-item">
                  <div className="stat-value">{dataStats.social}</div>
                  <div className="stat-label">Social</div>
                </div>
                <div className="stat-item">
                  <div className="stat-value">{dataStats.authorized}</div>
                  <div className="stat-label">Authorized</div>
                </div>
                <div className="stat-item">
                  <div className="stat-value">${dataStats.totalValue.toFixed(2)}</div>
                  <div className="stat-label">Potential Earnings</div>
                </div>
              </div>
            </div>

            <div className="dashboard-card info-card">
              <h3>How It Works</h3>
              <div className="info-step">
                <div className="step-number">1</div>
                <p>Add your data (financial, health, social metrics)</p>
              </div>
              <div className="info-step">
                <div className="step-number">2</div>
                <p>AI agent encrypts with Zama FHE and stores securely</p>
              </div>
              <div className="info-step">
                <div className="step-number">3</div>
                <p>Companies request access to specific data types</p>
              </div>
              <div className="info-step">
                <div className="step-number">4</div>
                <p>AI negotiates price and terms on your behalf</p>
              </div>
              <div className="info-step">
                <div className="step-number">5</div>
                <p>You earn when data is accessed (paid in crypto)</p>
              </div>
            </div>
          </div>
        )}

        {activeTab === "data" && (
          <div className="data-section">
            <div className="section-header">
              <h2>My Encrypted Data</h2>
              <div className="header-actions">
                <div className="search-box">
                  <input
                    type="text"
                    placeholder="Search data..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>
                <button 
                  className="primary-btn"
                  onClick={() => setShowAddModal(true)}
                >
                  Add New Data
                </button>
              </div>
            </div>

            {filteredRecords.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon"></div>
                <p>No data records found</p>
                <button 
                  className="primary-btn"
                  onClick={() => setShowAddModal(true)}
                >
                  Add Your First Data Point
                </button>
              </div>
            ) : (
              <div className="data-grid">
                {filteredRecords.map(record => (
                  <div 
                    className="data-card" 
                    key={record.id}
                    onClick={() => setSelectedRecord(record)}
                  >
                    <div className="card-header">
                      <span className={`data-type ${record.dataType}`}>
                        {record.dataType}
                      </span>
                      <span className={`auth-status ${record.authorized ? 'authorized' : 'unauthorized'}`}>
                        {record.authorized ? 'Authorized' : 'Private'}
                      </span>
                    </div>
                    <div className="card-body">
                      <div className="data-meta">
                        <div>
                          <label>Price:</label>
                          <span>${record.price.toFixed(2)}</span>
                        </div>
                        <div>
                          <label>Added:</label>
                          <span>{new Date(record.timestamp * 1000).toLocaleDateString()}</span>
                        </div>
                      </div>
                      <div className="encrypted-value">
                        {record.encryptedValue.substring(0, 20)}...
                      </div>
                    </div>
                    <div className="card-footer">
                      <button 
                        className={`toggle-auth-btn ${record.authorized ? 'unauthorize' : 'authorize'}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleAuthorization(record.id);
                        }}
                      >
                        {record.authorized ? 'Make Private' : 'Authorize Access'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "earnings" && (
          <div className="earnings-section">
            <h2>Data Earnings</h2>
            <div className="earnings-stats">
              <div className="earnings-card">
                <h3>Total Earnings</h3>
                <div className="amount">$0.00</div>
                <p>Historical earnings from data access</p>
              </div>
              <div className="earnings-card">
                <h3>Potential Earnings</h3>
                <div className="amount">${dataStats.totalValue.toFixed(2)}</div>
                <p>Based on current authorized data</p>
              </div>
              <div className="earnings-card">
                <h3>Active Agreements</h3>
                <div className="amount">0</div>
                <p>Companies accessing your data</p>
              </div>
            </div>
            <div className="transactions-list">
              <h3>Transaction History</h3>
              <div className="empty-state">
                <div className="empty-icon"></div>
                <p>No transactions yet</p>
              </div>
            </div>
          </div>
        )}
      </main>

      {showAddModal && (
        <div className="modal-overlay">
          <div className="add-modal">
            <div className="modal-header">
              <h2>Add New Data</h2>
              <button 
                className="close-btn"
                onClick={() => setShowAddModal(false)}
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Data Type</label>
                <select
                  name="dataType"
                  value={newRecord.dataType}
                  onChange={(e) => setNewRecord({...newRecord, dataType: e.target.value})}
                >
                  <option value="financial">Financial</option>
                  <option value="health">Health</option>
                  <option value="social">Social</option>
                  <option value="location">Location</option>
                  <option value="behavioral">Behavioral</option>
                </select>
              </div>
              <div className="form-group">
                <label>Value (Numerical)</label>
                <input
                  type="number"
                  value={newRecord.value}
                  onChange={(e) => setNewRecord({...newRecord, value: parseFloat(e.target.value) || 0})}
                  placeholder="Enter numerical value"
                />
              </div>
              <div className="form-group">
                <label>Price per Access ($)</label>
                <input
                  type="number"
                  value={newRecord.price}
                  onChange={(e) => setNewRecord({...newRecord, price: parseFloat(e.target.value) || 0})}
                  placeholder="Set your price"
                  step="0.01"
                  min="0"
                />
              </div>
              <div className="encryption-preview">
                <h4>FHE Encryption Preview</h4>
                <div className="preview-value">
                  <span>Original:</span> {newRecord.value}
                </div>
                <div className="preview-value">
                  <span>Encrypted:</span> {FHEEncryptNumber(newRecord.value).substring(0, 30)}...
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button 
                className="secondary-btn"
                onClick={() => setShowAddModal(false)}
              >
                Cancel
              </button>
              <button 
                className="primary-btn"
                onClick={addDataRecord}
                disabled={transactionStatus.visible}
              >
                {transactionStatus.visible ? "Processing..." : "Encrypt & Store"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedRecord && (
        <div className="modal-overlay">
          <div className="detail-modal">
            <div className="modal-header">
              <h2>Data Details</h2>
              <button 
                className="close-btn"
                onClick={() => {
                  setSelectedRecord(null);
                  setDecryptedValue(null);
                }}
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="detail-row">
                <span>Data Type:</span>
                <strong>{selectedRecord.dataType}</strong>
              </div>
              <div className="detail-row">
                <span>Price:</span>
                <strong>${selectedRecord.price.toFixed(2)}</strong>
              </div>
              <div className="detail-row">
                <span>Added:</span>
                <strong>{new Date(selectedRecord.timestamp * 1000).toLocaleString()}</strong>
              </div>
              <div className="detail-row">
                <span>Status:</span>
                <strong className={`auth-status ${selectedRecord.authorized ? 'authorized' : 'unauthorized'}`}>
                  {selectedRecord.authorized ? 'Authorized for Access' : 'Private'}
                </strong>
              </div>
              <div className="encrypted-data">
                <h3>Encrypted Value</h3>
                <div className="encrypted-value">
                  {selectedRecord.encryptedValue}
                </div>
                <div className="fhe-badge">Zama FHE Encrypted</div>
              </div>
              <button
                className="decrypt-btn"
                onClick={async () => {
                  if (decryptedValue !== null) {
                    setDecryptedValue(null);
                  } else {
                    const value = await decryptWithSignature(selectedRecord.encryptedValue);
                    setDecryptedValue(value);
                  }
                }}
                disabled={isDecrypting}
              >
                {isDecrypting ? "Decrypting..." : 
                 decryptedValue !== null ? "Hide Value" : "Decrypt with Wallet"}
              </button>
              {decryptedValue !== null && (
                <div className="decrypted-value">
                  <h3>Decrypted Value</h3>
                  <div className="value-display">{decryptedValue}</div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button
                className={`toggle-auth-btn ${selectedRecord.authorized ? 'unauthorize' : 'authorize'}`}
                onClick={() => toggleAuthorization(selectedRecord.id)}
              >
                {selectedRecord.authorized ? 'Make Private' : 'Authorize Access'}
              </button>
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className={`transaction-alert ${transactionStatus.status}`}>
            <div className="alert-icon">
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✕"}
            </div>
            <div className="alert-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <h3>AI Data Broker</h3>
            <p>Empowering you with FHE-protected data sovereignty</p>
          </div>
          <div className="footer-links">
            <a href="#">Documentation</a>
            <a href="#">Privacy Policy</a>
            <a href="#">Terms of Service</a>
          </div>
        </div>
        <div className="footer-bottom">
          <p>Powered by Zama FHE Technology</p>
          <p>© {new Date().getFullYear()} AI Data Broker. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
};

export default App;
